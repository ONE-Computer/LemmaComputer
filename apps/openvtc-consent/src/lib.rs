use std::{collections::BTreeSet, sync::Arc};

use affinidi_data_integrity::{DataIntegrityProof, SignOptions, crypto_suites::CryptoSuite};
use affinidi_secrets_resolver::secrets::Secret;
use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use trust_tasks_proof::affinidi::Verifier;
use trust_tasks_rs::{
    Proof, ProofVerifier, TrustTask,
    specs::task_consent::{decision::v0_1 as decision, request::v0_1 as request},
    validate::ValidatedPayload,
};

pub const ENROLLMENT_TYPE: &str = "https://onecomputer.dev/spec/openvtc/approver-enrollment/0.1";
pub const REQUEST_TYPE: &str = "https://trusttasks.org/spec/task-consent/request/0.1";
pub const DECISION_TYPE: &str = "https://trusttasks.org/spec/task-consent/decision/0.1";
const MAX_CLOCK_SKEW_SECONDS: i64 = 60;
const MAX_PROOF_ISSUED_SKEW_SECONDS: i64 = 300;

#[derive(Clone)]
pub struct AppState {
    token: Arc<str>,
    signer: Arc<Secret>,
    executor_did: Arc<str>,
    verification_method: Arc<str>,
}

impl AppState {
    pub fn from_seed(token: String, seed: [u8; 32]) -> Result<Self, ApiError> {
        if token.len() < 32 {
            return Err(ApiError::configuration(
                "OPENVTC_CONSENT_TOKEN must contain at least 32 characters",
            ));
        }
        let mut signer = Secret::generate_ed25519(None, Some(&seed));
        let multikey = signer
            .get_public_keymultibase()
            .map_err(|error| ApiError::configuration(format!("derive executor key: {error}")))?;
        let executor_did = format!("did:key:{multikey}");
        let verification_method = format!("{executor_did}#{multikey}");
        signer.id = verification_method.clone();
        Ok(Self {
            token: token.into(),
            signer: Arc::new(signer),
            executor_did: executor_did.into(),
            verification_method: verification_method.into(),
        })
    }
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(health))
        .route("/v1/profile", get(profile))
        .route("/v1/task-consent/requests", post(sign_request))
        .route("/v1/enrollments/verify", post(verify_enrollment))
        .route("/v1/task-consent/decisions/verify", post(verify_decision))
        .with_state(state)
}

#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl ApiError {
    fn bad_request(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code,
            message: message.into(),
        }
    }

    fn forbidden(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            code,
            message: message.into(),
        }
    }

    fn configuration(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "CONFIGURATION_INVALID",
            message: message.into(),
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "OPENVTC_INTERNAL",
            message: message.into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({ "error": { "code": self.code, "message": self.message } })),
        )
            .into_response()
    }
}

fn authenticate(headers: &HeaderMap, state: &AppState) -> Result<(), ApiError> {
    let supplied = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or_default();
    let valid = supplied.len() == state.token.len()
        && supplied.as_bytes().ct_eq(state.token.as_bytes()).into();
    if valid {
        Ok(())
    } else {
        Err(ApiError {
            status: StatusCode::UNAUTHORIZED,
            code: "UNAUTHENTICATED",
            message: "service authentication is required".into(),
        })
    }
}

async fn health() -> Json<Value> {
    Json(json!({ "ok": true }))
}

async fn profile(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authenticate(&headers, &state)?;
    Ok(Json(json!({
        "executorDid": state.executor_did,
        "verificationMethod": state.verification_method,
        "profile": {
            "trustTasks": "0.2.37",
            "trustTasksProof": "0.2.1",
            "affinidiDataIntegrity": "0.7.7",
            "vtaPolicy": "0.1.0"
        }
    })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignRequestInput {
    id: String,
    recipient_did: String,
    issued_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
    challenge: String,
    task_type: String,
    task_payload: Value,
    requester_did: String,
    approver_set: String,
    min_approvals: u64,
    exclude_requester: bool,
    side_effects: String,
    exposure: Value,
    effects: Value,
    consequences: Value,
    subject: Option<String>,
    origin: Option<String>,
    state_pin: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedRequestOutput {
    pub document: Value,
    pub payload_digest: String,
    pub document_hash: String,
    pub proof_hash: String,
    pub signer_did: String,
    pub verification_method: String,
}

async fn sign_request(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<SignRequestInput>,
) -> Result<Json<SignedRequestOutput>, ApiError> {
    authenticate(&headers, &state)?;
    if input.expires_at <= input.issued_at {
        return Err(ApiError::bad_request(
            "OPENVTC_REQUEST_INVALID",
            "expiresAt must be later than issuedAt",
        ));
    }
    let payload_digest =
        vta_policy::consent::wire_digest(&input.task_type, &input.task_payload, &input.challenge)
            .map_err(|error| ApiError::bad_request("OPENVTC_REQUEST_INVALID", error.to_string()))?;
    let mut payload_value = json!({
        "challenge": input.challenge,
        "taskType": input.task_type,
        "payloadDigest": payload_digest,
        "sideEffects": input.side_effects,
        "exposure": input.exposure,
        "effects": input.effects,
        "consequences": input.consequences,
        "requester": input.requester_did,
        "approverSet": input.approver_set,
        "minApprovals": input.min_approvals,
        "excludeRequester": input.exclude_requester,
        "expiresAt": input.expires_at,
    });
    let payload_object = payload_value
        .as_object_mut()
        .expect("payload literal is an object");
    if let Some(subject) = input.subject {
        payload_object.insert("subject".into(), json!(subject));
    }
    if let Some(origin) = input.origin {
        payload_object.insert("origin".into(), json!(origin));
    }
    if let Some(state_pin) = input.state_pin {
        payload_object.insert("statePin".into(), state_pin);
    }
    request::Payload::validate_value(&payload_value).map_err(|error| {
        ApiError::bad_request("OPENVTC_REQUEST_SCHEMA_INVALID", error.to_string())
    })?;
    let payload: request::Payload = serde_json::from_value(payload_value).map_err(|error| {
        ApiError::bad_request("OPENVTC_REQUEST_SCHEMA_INVALID", error.to_string())
    })?;
    let mut document = TrustTask::for_payload(input.id, payload);
    document.issuer = Some(state.executor_did.to_string());
    document.recipient = Some(input.recipient_did);
    document.issued_at = Some(input.issued_at);
    document.expires_at = Some(input.expires_at);
    let unsigned = serde_json::to_value(&document)
        .map_err(|error| ApiError::internal(format!("serialize request: {error}")))?;
    let proof = DataIntegrityProof::sign(
        &unsigned,
        state.signer.as_ref(),
        SignOptions::new()
            .with_proof_purpose("assertionMethod")
            .with_cryptosuite(CryptoSuite::EddsaJcs2022)
            .with_created(input.issued_at),
    )
    .await
    .map_err(|error| ApiError::internal(format!("sign request: {error}")))?;
    let proof_value = serde_json::to_value(&proof)
        .map_err(|error| ApiError::internal(format!("serialize proof: {error}")))?;
    document.proof = Some(
        serde_json::from_value::<Proof>(proof_value.clone())
            .map_err(|error| ApiError::internal(format!("parse proof: {error}")))?,
    );
    document.enforce_spec_policy().map_err(|error| {
        ApiError::internal(format!(
            "signed request violates Task Consent policy: {error}"
        ))
    })?;
    Verifier::for_did_key()
        .verify(&document)
        .await
        .map_err(|error| ApiError::internal(format!("self-verify request: {error}")))?;
    let document = serde_json::to_value(document)
        .map_err(|error| ApiError::internal(format!("serialize signed request: {error}")))?;
    Ok(Json(SignedRequestOutput {
        document_hash: jcs_hash(&document)?,
        proof_hash: jcs_hash(&proof_value)?,
        document,
        payload_digest,
        signer_did: state.executor_did.to_string(),
        verification_method: state.verification_method.to_string(),
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnrollmentExpected {
    recipient_did: String,
    challenge: String,
    tenant_id: String,
    subject_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VerifyEnrollmentInput {
    document: Value,
    expected: EnrollmentExpected,
    now: DateTime<Utc>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedEnrollmentOutput {
    pub signer_did: String,
    pub verification_method: String,
    pub display_name: String,
    pub document_hash: String,
    pub proof_hash: String,
}

async fn verify_enrollment(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<VerifyEnrollmentInput>,
) -> Result<Json<VerifiedEnrollmentOutput>, ApiError> {
    authenticate(&headers, &state)?;
    validate_document_shape(&input.document, true, "enrollment")?;
    let document: TrustTask<Value> =
        serde_json::from_value(input.document.clone()).map_err(|error| {
            ApiError::bad_request("OPENVTC_ENROLLMENT_SCHEMA_INVALID", error.to_string())
        })?;
    if document.type_uri.to_string() != ENROLLMENT_TYPE {
        return Err(ApiError::forbidden(
            "OPENVTC_ENROLLMENT_TYPE_INVALID",
            "unexpected enrollment type",
        ));
    }
    document
        .validate_basic(
            input.now - Duration::seconds(MAX_CLOCK_SKEW_SECONDS),
            &input.expected.recipient_did,
        )
        .map_err(|error| {
            ApiError::forbidden("OPENVTC_ENROLLMENT_BINDING_INVALID", error.to_string())
        })?;
    Verifier::for_did_key()
        .verify(&document)
        .await
        .map_err(|error| {
            ApiError::forbidden("OPENVTC_ENROLLMENT_PROOF_INVALID", error.to_string())
        })?;
    let payload = object(&document.payload, "enrollment payload")?;
    exact_keys(
        payload,
        &[
            "challenge",
            "tenantId",
            "subjectId",
            "verificationMethod",
            "displayName",
        ],
        "enrollment payload",
    )?;
    expect_string(payload, "challenge", &input.expected.challenge)?;
    expect_string(payload, "tenantId", &input.expected.tenant_id)?;
    expect_string(payload, "subjectId", &input.expected.subject_id)?;
    let signer_did = document.issuer.as_deref().ok_or_else(|| {
        ApiError::forbidden("OPENVTC_ENROLLMENT_BINDING_INVALID", "issuer is required")
    })?;
    let verification_method = document
        .proof
        .as_ref()
        .map(|proof| proof.verification_method.as_str())
        .ok_or_else(|| {
            ApiError::forbidden("OPENVTC_ENROLLMENT_PROOF_INVALID", "proof is required")
        })?;
    if verification_method != did_key_verification_method(signer_did)? {
        return Err(ApiError::forbidden(
            "OPENVTC_ENROLLMENT_PROOF_INVALID",
            "verification method does not match the issuer did:key",
        ));
    }
    expect_string(payload, "verificationMethod", verification_method)?;
    let display_name = payload
        .get("displayName")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty() && value.chars().count() <= 100)
        .ok_or_else(|| {
            ApiError::bad_request(
                "OPENVTC_ENROLLMENT_SCHEMA_INVALID",
                "displayName is invalid",
            )
        })?
        .to_string();
    validate_proof_time(&document, input.now)?;
    Ok(Json(VerifiedEnrollmentOutput {
        signer_did: signer_did.to_string(),
        verification_method: verification_method.to_string(),
        display_name,
        document_hash: jcs_hash(&input.document)?,
        proof_hash: jcs_hash(input.document.get("proof").unwrap_or(&Value::Null))?,
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnrolledApproverExpected {
    signer_did: String,
    verification_method: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DecisionExpected {
    recipient_did: String,
    challenge: String,
    payload_digest: String,
    enrolled_approvers: Vec<EnrolledApproverExpected>,
    request_issued_at: DateTime<Utc>,
    request_expires_at: DateTime<Utc>,
    requester_did: String,
    exclude_requester: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VerifyDecisionInput {
    document: Value,
    expected: DecisionExpected,
    now: DateTime<Utc>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedDecisionOutput {
    pub signer_did: String,
    pub verification_method: String,
    pub challenge: String,
    pub payload_digest: String,
    pub decision: String,
    pub issued_at: DateTime<Utc>,
    pub document_hash: String,
    pub proof_hash: String,
}

async fn verify_decision(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<VerifyDecisionInput>,
) -> Result<Json<VerifiedDecisionOutput>, ApiError> {
    authenticate(&headers, &state)?;
    if input.now >= input.expected.request_expires_at {
        return Err(ApiError::forbidden(
            "OPENVTC_DECISION_TIME_INVALID",
            "the consent request has expired",
        ));
    }
    validate_document_shape(&input.document, false, "decision")?;
    let payload_value = input.document.get("payload").cloned().ok_or_else(|| {
        ApiError::bad_request("OPENVTC_DECISION_SCHEMA_INVALID", "payload is required")
    })?;
    decision::Payload::validate_value(&payload_value).map_err(|error| {
        ApiError::bad_request("OPENVTC_DECISION_SCHEMA_INVALID", error.to_string())
    })?;
    let document: TrustTask<decision::Payload> = serde_json::from_value(input.document.clone())
        .map_err(|error| {
            ApiError::bad_request("OPENVTC_DECISION_SCHEMA_INVALID", error.to_string())
        })?;
    if document.type_uri.to_string() != DECISION_TYPE {
        return Err(ApiError::forbidden(
            "OPENVTC_DECISION_TYPE_INVALID",
            "unexpected decision type",
        ));
    }
    document.enforce_spec_policy().map_err(|error| {
        ApiError::forbidden("OPENVTC_DECISION_BINDING_INVALID", error.to_string())
    })?;
    document
        .validate_basic(
            input.now - Duration::seconds(MAX_CLOCK_SKEW_SECONDS),
            &input.expected.recipient_did,
        )
        .map_err(|error| {
            ApiError::forbidden("OPENVTC_DECISION_BINDING_INVALID", error.to_string())
        })?;
    Verifier::for_did_key()
        .verify(&document)
        .await
        .map_err(|error| {
            ApiError::forbidden("OPENVTC_DECISION_PROOF_INVALID", error.to_string())
        })?;
    let signer_did = document.issuer.as_deref().ok_or_else(|| {
        ApiError::forbidden("OPENVTC_DECISION_BINDING_INVALID", "issuer is required")
    })?;
    let verification_method = document
        .proof
        .as_ref()
        .map(|proof| proof.verification_method.as_str())
        .ok_or_else(|| {
            ApiError::forbidden("OPENVTC_DECISION_PROOF_INVALID", "proof is required")
        })?;
    if verification_method != did_key_verification_method(signer_did)?
        || !input.expected.enrolled_approvers.iter().any(|approver| {
            approver.signer_did == signer_did && approver.verification_method == verification_method
        })
    {
        return Err(ApiError::forbidden(
            "OPENVTC_DECISION_APPROVER_INVALID",
            "signer and verification method are not an enrolled approver",
        ));
    }
    if input.expected.exclude_requester && signer_did == input.expected.requester_did {
        return Err(ApiError::forbidden(
            "OPENVTC_DECISION_REQUESTER_EXCLUDED",
            "the requester cannot approve this task",
        ));
    }
    let issued_at = document.issued_at.ok_or_else(|| {
        ApiError::forbidden("OPENVTC_DECISION_BINDING_INVALID", "issuedAt is required")
    })?;
    if issued_at < input.expected.request_issued_at - Duration::seconds(MAX_CLOCK_SKEW_SECONDS)
        || issued_at > input.expected.request_expires_at + Duration::seconds(MAX_CLOCK_SKEW_SECONDS)
        || issued_at > input.now + Duration::seconds(MAX_CLOCK_SKEW_SECONDS)
    {
        return Err(ApiError::forbidden(
            "OPENVTC_DECISION_TIME_INVALID",
            "decision issuedAt is outside the request validity window",
        ));
    }
    if *document.payload.challenge != input.expected.challenge
        || document.payload.payload_digest != input.expected.payload_digest
    {
        return Err(ApiError::forbidden(
            "OPENVTC_DECISION_BINDING_INVALID",
            "decision does not match the challenge and action digest",
        ));
    }
    validate_proof_time(&document, input.now)?;
    let decision = document.payload.decision.to_string();
    Ok(Json(VerifiedDecisionOutput {
        signer_did: signer_did.to_string(),
        verification_method: verification_method.to_string(),
        challenge: document.payload.challenge.to_string(),
        payload_digest: document.payload.payload_digest.clone(),
        decision,
        issued_at,
        document_hash: jcs_hash(&input.document)?,
        proof_hash: jcs_hash(input.document.get("proof").unwrap_or(&Value::Null))?,
    }))
}

fn validate_document_shape(document: &Value, expires: bool, label: &str) -> Result<(), ApiError> {
    let document = object(document, label)?;
    let mut fields = vec![
        "id",
        "type",
        "issuer",
        "recipient",
        "issuedAt",
        "payload",
        "proof",
    ];
    if expires {
        fields.push("expiresAt");
    }
    exact_keys(document, &fields, label)?;
    exact_keys(
        object(
            document.get("proof").ok_or_else(|| {
                ApiError::bad_request("OPENVTC_SCHEMA_INVALID", "proof is required")
            })?,
            "proof",
        )?,
        &[
            "type",
            "cryptosuite",
            "verificationMethod",
            "created",
            "proofPurpose",
            "proofValue",
        ],
        "proof",
    )
}

fn did_key_verification_method(did: &str) -> Result<String, ApiError> {
    let multikey = did
        .strip_prefix("did:key:")
        .filter(|value| value.starts_with('z'));
    multikey
        .map(|multikey| format!("{did}#{multikey}"))
        .ok_or_else(|| {
            ApiError::forbidden(
                "OPENVTC_DID_METHOD_INVALID",
                "only the canonical did:key multikey profile is supported",
            )
        })
}

fn validate_proof_time<P>(document: &TrustTask<P>, now: DateTime<Utc>) -> Result<(), ApiError> {
    let proof = document
        .proof
        .as_ref()
        .ok_or_else(|| ApiError::forbidden("OPENVTC_PROOF_INVALID", "proof is required"))?;
    if proof.proof_purpose != "assertionMethod"
        || proof.cryptosuite != "eddsa-jcs-2022"
        || proof.created > now + Duration::seconds(MAX_CLOCK_SKEW_SECONDS)
        || document.issued_at.is_some_and(|issued| {
            (proof.created - issued).num_seconds().abs() > MAX_PROOF_ISSUED_SKEW_SECONDS
        })
    {
        return Err(ApiError::forbidden(
            "OPENVTC_PROOF_INVALID",
            "proof profile or creation time is invalid",
        ));
    }
    Ok(())
}

fn object<'a>(
    value: &'a Value,
    label: &str,
) -> Result<&'a serde_json::Map<String, Value>, ApiError> {
    value.as_object().ok_or_else(|| {
        ApiError::bad_request(
            "OPENVTC_SCHEMA_INVALID",
            format!("{label} must be an object"),
        )
    })
}

fn exact_keys(
    object: &serde_json::Map<String, Value>,
    expected: &[&str],
    label: &str,
) -> Result<(), ApiError> {
    let actual: BTreeSet<&str> = object.keys().map(String::as_str).collect();
    let expected: BTreeSet<&str> = expected.iter().copied().collect();
    if actual == expected {
        Ok(())
    } else {
        Err(ApiError::bad_request(
            "OPENVTC_SCHEMA_INVALID",
            format!("{label} contains missing or unknown fields"),
        ))
    }
}

fn expect_string(
    object: &serde_json::Map<String, Value>,
    field: &str,
    expected: &str,
) -> Result<(), ApiError> {
    if object.get(field).and_then(Value::as_str) == Some(expected) {
        Ok(())
    } else {
        Err(ApiError::forbidden(
            "OPENVTC_BINDING_INVALID",
            format!("{field} does not match"),
        ))
    }
}

fn jcs_hash(value: &Value) -> Result<String, ApiError> {
    let canonical = serde_json_canonicalizer::to_string(value)
        .map_err(|error| ApiError::internal(format!("canonicalize evidence: {error}")))?;
    Ok(hex::encode(Sha256::digest(canonical.as_bytes())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::State;
    use tower::ServiceExt;

    const TOKEN: &str = "test-service-token-with-at-least-32-characters";

    fn state() -> AppState {
        AppState::from_seed(TOKEN.into(), [7; 32]).unwrap()
    }

    fn headers() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", format!("Bearer {TOKEN}").parse().unwrap());
        headers
    }

    fn approver(seed: [u8; 32]) -> (Secret, String, String) {
        let mut secret = Secret::generate_ed25519(None, Some(&seed));
        let multikey = secret.get_public_keymultibase().unwrap();
        let did = format!("did:key:{multikey}");
        let verification_method = format!("{did}#{multikey}");
        secret.id = verification_method.clone();
        (secret, did, verification_method)
    }

    async fn sign_value(mut document: Value, secret: &Secret, created: DateTime<Utc>) -> Value {
        document.as_object_mut().unwrap().remove("proof");
        let proof = DataIntegrityProof::sign(
            &document,
            secret,
            SignOptions::new()
                .with_proof_purpose("assertionMethod")
                .with_cryptosuite(CryptoSuite::EddsaJcs2022)
                .with_created(created),
        )
        .await
        .unwrap();
        document["proof"] = serde_json::to_value(proof).unwrap();
        document
    }

    fn request_input(challenge: &str) -> SignRequestInput {
        let issued_at = Utc::now();
        SignRequestInput {
            id: "urn:uuid:32d29da1-2333-449c-a7bb-1e7a1310bc9e".into(),
            recipient_did: approver([9; 32]).1,
            issued_at,
            expires_at: issued_at + Duration::minutes(10),
            challenge: challenge.into(),
            task_type: "https://onecomputer.dev/spec/microsoft365/tool-call/0.1".into(),
            task_payload: json!({
                "operationDigest": "a".repeat(64),
                "arguments": {"confirm": true, "private": "must-not-leak"}
            }),
            requester_did: "did:onecomputer:agent:test".into(),
            approver_set: "onecomputer-workspace-owners".into(),
            min_approvals: 1,
            exclude_requester: true,
            side_effects: "destructive".into(),
            exposure: json!({"discloses": "none", "actsAsSubject": true}),
            effects: json!([{"kind": "delete", "summary": "Delete the selected resource."}]),
            consequences: json!(["The selected resource is removed."]),
            subject: Some("urn:onecomputer:operation:test".into()),
            origin: Some("ONEComputer Control".into()),
            state_pin: Some(json!({"resource": "resource-1", "version": "etag-1"})),
        }
    }

    #[tokio::test]
    async fn health_does_not_require_authentication() {
        let response = router(state())
            .oneshot(
                axum::http::Request::builder()
                    .uri("/healthz")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[test]
    fn derives_stable_did_key_from_seed() {
        let first = state();
        let second = state();
        assert_eq!(first.executor_did, second.executor_did);
        assert!(
            first
                .verification_method
                .starts_with(first.executor_did.as_ref())
        );
    }

    #[test]
    fn rejects_short_service_tokens() {
        assert!(AppState::from_seed("short".into(), [7; 32]).is_err());
    }

    #[test]
    fn upstream_wire_digest_is_challenge_bound() {
        let payload = json!({"tool": "delete-message", "id": "42"});
        let a = vta_policy::consent::wire_digest(
            "https://example.test/task",
            &payload,
            "a234567890123456",
        )
        .unwrap();
        let b = vta_policy::consent::wire_digest(
            "https://example.test/task",
            &payload,
            "b234567890123456",
        )
        .unwrap();
        assert_ne!(a, b);
    }

    #[tokio::test]
    async fn signs_schema_valid_recipient_bound_requests_without_raw_payload_disclosure() {
        let state = state();
        let output = sign_request(
            State(state.clone()),
            headers(),
            Json(request_input("0123456789abcdef")),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(output.signer_did, state.executor_did.as_ref());
        assert_eq!(output.document["recipient"], approver([9; 32]).1);
        assert_eq!(output.document["type"], REQUEST_TYPE);
        assert_eq!(output.document["proof"]["cryptosuite"], "eddsa-jcs-2022");
        assert!(!output.document.to_string().contains("must-not-leak"));
        assert_eq!(output.document_hash.len(), 64);
        assert_eq!(output.proof_hash.len(), 64);

        let changed = sign_request(
            State(state),
            headers(),
            Json(request_input("fedcba9876543210")),
        )
        .await
        .unwrap()
        .0;
        assert_ne!(output.payload_digest, changed.payload_digest);
    }

    #[tokio::test]
    async fn enrollment_verification_binds_signature_identity_and_entra_subject() {
        let state = state();
        let executor_did = state.executor_did.to_string();
        let (secret, did, verification_method) = approver([11; 32]);
        let now = Utc::now();
        let expected = EnrollmentExpected {
            recipient_did: executor_did.clone(),
            challenge: "enrollment-challenge-012345".into(),
            tenant_id: "tenant-1".into(),
            subject_id: "subject-1".into(),
        };
        let document = sign_value(
            json!({
                "id": "urn:uuid:4cd8857c-9e3e-4052-b1d9-399b85740428",
                "type": ENROLLMENT_TYPE,
                "issuer": did,
                "recipient": state.executor_did,
                "issuedAt": now,
                "expiresAt": now + Duration::minutes(5),
                "payload": {
                    "challenge": expected.challenge,
                    "tenantId": expected.tenant_id,
                    "subjectId": expected.subject_id,
                    "verificationMethod": verification_method,
                    "displayName": "Test browser"
                }
            }),
            &secret,
            now - Duration::seconds(60),
        )
        .await;
        let verified = verify_enrollment(
            State(state.clone()),
            headers(),
            Json(VerifyEnrollmentInput {
                document: document.clone(),
                expected,
                now,
            }),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(verified.signer_did, did);
        assert_eq!(verified.display_name, "Test browser");

        let mut extended = document.clone();
        extended["unexpected"] = json!(true);
        assert!(
            verify_enrollment(
                State(state.clone()),
                headers(),
                Json(VerifyEnrollmentInput {
                    document: extended,
                    expected: EnrollmentExpected {
                        recipient_did: executor_did.clone(),
                        challenge: "enrollment-challenge-012345".into(),
                        tenant_id: "tenant-1".into(),
                        subject_id: "subject-1".into(),
                    },
                    now,
                }),
            )
            .await
            .is_err()
        );

        let mut tampered = document;
        tampered["payload"]["subjectId"] = json!("attacker");
        let rejected = verify_enrollment(
            State(state),
            headers(),
            Json(VerifyEnrollmentInput {
                document: tampered,
                expected: EnrollmentExpected {
                    recipient_did: executor_did,
                    challenge: "enrollment-challenge-012345".into(),
                    tenant_id: "tenant-1".into(),
                    subject_id: "subject-1".into(),
                },
                now,
            }),
        )
        .await;
        assert!(rejected.is_err());
    }

    #[tokio::test]
    async fn decision_verification_rejects_tampering_expiry_and_unenrolled_signers() {
        let state = state();
        let (secret, did, _) = approver([13; 32]);
        let issued_at = Utc::now();
        let expires_at = issued_at + Duration::minutes(10);
        let digest = "b".repeat(64);
        let challenge = "decision-challenge-012345";
        let document = sign_value(
            json!({
                "id": "urn:uuid:cd456c05-77fc-4eb8-b00c-02abaf359684",
                "type": DECISION_TYPE,
                "issuer": did,
                "recipient": state.executor_did,
                "issuedAt": issued_at,
                "payload": {
                    "challenge": challenge,
                    "payloadDigest": digest,
                    "decision": "approve"
                }
            }),
            &secret,
            issued_at - Duration::seconds(60),
        )
        .await;
        let expected = || DecisionExpected {
            recipient_did: state.executor_did.to_string(),
            challenge: challenge.into(),
            payload_digest: digest.clone(),
            enrolled_approvers: vec![EnrolledApproverExpected {
                signer_did: did.clone(),
                verification_method: format!("{did}#{}", did.trim_start_matches("did:key:")),
            }],
            request_issued_at: issued_at - Duration::seconds(1),
            request_expires_at: expires_at,
            requester_did: "did:key:zRequester".into(),
            exclude_requester: true,
        };
        let verified = verify_decision(
            State(state.clone()),
            headers(),
            Json(VerifyDecisionInput {
                document: document.clone(),
                expected: expected(),
                now: issued_at + Duration::seconds(1),
            }),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(verified.signer_did, did);
        assert_eq!(verified.decision, "approve");

        let mut extended = document.clone();
        extended["proof"]["unexpected"] = json!(true);
        assert!(
            verify_decision(
                State(state.clone()),
                headers(),
                Json(VerifyDecisionInput {
                    document: extended,
                    expected: expected(),
                    now: issued_at + Duration::seconds(1),
                }),
            )
            .await
            .is_err()
        );

        let mut tampered = document.clone();
        tampered["payload"]["decision"] = json!("deny");
        assert!(
            verify_decision(
                State(state.clone()),
                headers(),
                Json(VerifyDecisionInput {
                    document: tampered,
                    expected: expected(),
                    now: issued_at + Duration::seconds(1),
                }),
            )
            .await
            .is_err()
        );
        let mut unregistered = expected();
        unregistered.enrolled_approvers.clear();
        assert!(
            verify_decision(
                State(state.clone()),
                headers(),
                Json(VerifyDecisionInput {
                    document: document.clone(),
                    expected: unregistered,
                    now: issued_at + Duration::seconds(1),
                }),
            )
            .await
            .is_err()
        );
        let mut wrong_key = expected();
        wrong_key.enrolled_approvers[0].verification_method = "did:key:zWrong#zWrong".into();
        assert!(
            verify_decision(
                State(state.clone()),
                headers(),
                Json(VerifyDecisionInput {
                    document: document.clone(),
                    expected: wrong_key,
                    now: issued_at + Duration::seconds(1),
                }),
            )
            .await
            .is_err()
        );
        assert!(
            verify_decision(
                State(state.clone()),
                headers(),
                Json(VerifyDecisionInput {
                    document,
                    expected: expected(),
                    now: expires_at,
                }),
            )
            .await
            .is_err()
        );
    }
}
