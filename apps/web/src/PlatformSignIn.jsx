import { useEffect, useMemo, useState } from "react";
import { platformPasskeyApi } from "./platform-auth-client.js";

const safeReturnPath = () => {
  const value = new URLSearchParams(window.location.search).get("return");
  if (!value?.startsWith("/") || value.startsWith("//")) return "/api/v1/platform/ui";
  try {
    const base = new URL(window.location.origin);
    const parsed = new URL(value, base);
    return parsed.origin === base.origin ? `${parsed.pathname}${parsed.search}${parsed.hash}` : "/api/v1/platform/ui";
  } catch {
    return "/api/v1/platform/ui";
  }
};

export function PlatformSignIn() {
  const returnPath = useMemo(safeReturnPath, []);
  const stepUp = new URLSearchParams(window.location.search).get("mode") === "step-up";
  const [capabilities, setCapabilities] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  useEffect(() => {
    platformPasskeyApi.capabilities().then(setCapabilities).catch((failure) => setError(failure.message));
  }, []);

  const signIn = async () => {
    setBusy("signin");
    setError("");
    setStatus("Waiting for your security key…");
    try {
      await platformPasskeyApi.signIn();
      window.location.assign(returnPath);
    } catch (failure) {
      setError(failure.message ?? "Platform sign-in was not completed.");
      setStatus("");
      setBusy("");
    }
  };

  const bootstrap = async () => {
    setBusy("bootstrap");
    setError("");
    try {
      setStatus("Preparing the isolated local operator account…");
      const state = await platformPasskeyApi.beginDevelopmentBootstrap();
      if (!state.enrolled) {
        setStatus("Register your platform security key…");
        await platformPasskeyApi.add();
        setStatus("Removing the temporary bootstrap credential…");
        await platformPasskeyApi.finalizeDevelopmentBootstrap();
      }
      setStatus("Verify the enrolled security key to enter platform operations…");
      await platformPasskeyApi.signIn();
      window.location.assign(returnPath);
    } catch (failure) {
      setError(failure.message ?? "Local platform enrollment was not completed.");
      setStatus("");
      setBusy("");
    }
  };

  return <main className="signin-screen">
    <section className="signin-card platform-signin-card">
      <div className="brand signin-brand" aria-label="LemmaComputer"><strong>Lemma</strong><span>Computer</span></div>
      <p>Platform operations</p>
      <h1>{stepUp ? "Verify this sensitive action" : "Platform administrator sign-in"}</h1>
      <span>{stepUp
        ? "Use your registered security key again. Customer accounts and organization SSO cannot authorize this action."
        : "This separate operator realm controls workspace-node placement and hosted infrastructure settings."}</span>
      {error && <div className="connection-error" role="alert"><span><strong>Platform access was not granted</strong>{error}</span></div>}
      {status && <div className="signin-status" role="status">{status}</div>}
      <button className="primary-button signin-button" type="button" disabled={Boolean(busy) || !capabilities} onClick={signIn}>
        {busy === "signin" ? "Verifying security key…" : "Sign in with a security key"}
      </button>
      {capabilities?.developmentBootstrap && !stepUp && <button className="secondary-button signin-button" type="button" disabled={Boolean(busy)} onClick={bootstrap}>
        {busy === "bootstrap" ? "Setting up local access…" : "Set up local platform access"}
      </button>}
      {capabilities?.developmentBootstrap && !stepUp && <small>Development only: the temporary bootstrap credential is removed after the first passkey is registered.</small>}
    </section>
  </main>;
}
