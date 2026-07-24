import React, { useEffect, useRef, useState } from "react";
import { Dismiss24Regular } from "@fluentui/react-icons/svg/dismiss";
import { Info24Regular } from "@fluentui/react-icons/svg/info";
import { ShieldCheckmark24Regular } from "@fluentui/react-icons/svg/shield-checkmark";

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function ModalDialog({ title, description, children, onClose, labelledBy = "modal-title", eyebrow = "Confirm action" }) {
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  const closeHandler = useRef(onClose);
  closeHandler.current = onClose;

  useEffect(() => {
    const previouslyFocused = document.activeElement;
    closeRef.current?.focus();
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeHandler.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = [...(dialogRef.current?.querySelectorAll(focusableSelector) ?? [])];
      if (!items.length) return;
      const first = items[0];
      const last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, []);

  return (
    <div className="modal-layer" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={description ? `${labelledBy}-description` : undefined}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div>
            <p>{eyebrow}</p>
            <h2 id={labelledBy}>{title}</h2>
          </div>
          <button ref={closeRef} className="icon-button" type="button" onClick={onClose} aria-label="Close dialog">
            <Dismiss24Regular aria-hidden="true" />
          </button>
        </header>
        {description && <p id={`${labelledBy}-description`} className="modal-description">{description}</p>}
        {children}
      </section>
    </div>
  );
}

export function NoticeDialog({ title, description, onClose }) {
  return (
    <ModalDialog title={title} description={description} onClose={onClose} labelledBy="notice-dialog-title" eyebrow="Configuration saved">
      <div className="modal-notice">
        <Info24Regular aria-hidden="true" />
        <span>The saved configuration is now the source of truth for the next sandbox launch.</span>
      </div>
      <div className="modal-actions">
        <button className="primary-button" type="button" onClick={onClose}>Got it</button>
      </div>
    </ModalDialog>
  );
}

export function ConfirmDialog({ title, description, confirmLabel, danger = false, busy = false, onConfirm, onCancel }) {
  return (
    <ModalDialog title={title} description={description} onClose={busy ? () => undefined : onCancel} labelledBy="confirm-dialog-title">
      <div className="modal-notice">
        <Info24Regular aria-hidden="true" />
        <span>This change only applies after ONEComputer confirms it.</span>
      </div>
      <div className="modal-actions">
        <button className="secondary-button" type="button" disabled={busy} onClick={onCancel}>Cancel</button>
        <button className={danger ? "primary-button destructive-button" : "primary-button"} type="button" disabled={busy} onClick={onConfirm}>
          {busy ? "Applying change" : confirmLabel}
        </button>
      </div>
    </ModalDialog>
  );
}

export function TextPromptDialog({ title, description, label, defaultValue = "", confirmLabel, busy = false, onConfirm, onCancel }) {
  const [value, setValue] = useState(defaultValue);
  return (
    <ModalDialog title={title} description={description} onClose={busy ? () => undefined : onCancel} labelledBy="text-prompt-title">
      <label className="modal-field" htmlFor="text-prompt-value">
        <span>{label}</span>
        <input
          id="text-prompt-value"
          value={value}
          maxLength={180}
          autoFocus
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && value.trim()) onConfirm(value.trim());
          }}
        />
      </label>
      <div className="modal-actions">
        <button className="secondary-button" type="button" disabled={busy} onClick={onCancel}>Cancel</button>
        <button className="primary-button" type="button" disabled={busy || !value.trim()} onClick={() => onConfirm(value.trim())}>
          {busy ? "Creating version" : confirmLabel}
        </button>
      </div>
    </ModalDialog>
  );
}

export function StatusBadge({ tone = "neutral", children }) {
  return <span className={`ui-status-badge ${tone}`}>{children}</span>;
}

const policyStates = {
  match: {
    label: "Policy verified",
    tone: "success",
    title: "Workspace policy matches external enforcement",
    detail: "The policy projected into this workspace matches the version independently enforced by ONEComputer.",
  },
  drift: {
    label: "Policy mismatch",
    tone: "danger",
    title: "Workspace policy does not match",
    detail: "The projected workspace policy differs from the externally enforced assignment. New privileged activity remains blocked.",
  },
  invalid: {
    label: "Invalid signature",
    tone: "danger",
    title: "Workspace policy could not be verified",
    detail: "The projected policy was changed or signed by an invalid key. External enforcement does not trust it.",
  },
  expired: {
    label: "Policy expired",
    tone: "warning",
    title: "Workspace policy needs a refresh",
    detail: "The projected signed policy has expired. Restart the workspace to receive the current verified assignment.",
  },
  unavailable: {
    label: "Needs rebuild",
    tone: "warning",
    title: "No verified policy projection",
    detail: "This workspace predates signed policy projection or its projection is unavailable. Rebuild it before relying on privileged access.",
  },
};

const shortDigest = (value) => value ? `${value.slice(0, 12)}…` : "Not available";

export function PolicyIntegrityCard({ integrity, compact = false }) {
  if (!integrity) return null;
  const content = policyStates[integrity.state] ?? policyStates.unavailable;
  return (
    <section className={`policy-integrity-card ${content.tone}${compact ? " compact" : ""}`} aria-labelledby="policy-integrity-title">
      <div className="policy-integrity-icon"><ShieldCheckmark24Regular aria-hidden="true" /></div>
      <div className="policy-integrity-copy">
        <div className="policy-integrity-heading">
          <div>
            <p>Signed workspace policy</p>
            <h2 id="policy-integrity-title">{content.title}</h2>
          </div>
          <StatusBadge tone={content.tone}>{content.label}</StatusBadge>
        </div>
        <span>{content.detail}</span>
        <dl className="policy-integrity-values">
          <div><dt>Assigned</dt><dd>v{integrity.expected.version} · <code>{shortDigest(integrity.expected.digest)}</code></dd></div>
          <div><dt>In workspace</dt><dd>{integrity.projected ? `v${integrity.projected.version}` : "Not verified"}{integrity.projected && <> · <code>{shortDigest(integrity.projected.digest)}</code></>}</dd></div>
          <div><dt>Enforced</dt><dd>{integrity.enforced ? `v${integrity.enforced.version}` : "Unavailable"}{integrity.enforced && <> · <code>{shortDigest(integrity.enforced.digest)}</code></>}</dd></div>
          <div><dt>Signing key</dt><dd><code>{integrity.enforced?.keyId ?? integrity.projected?.keyId ?? "Not available"}</code></dd></div>
        </dl>
      </div>
    </section>
  );
}

export class AppErrorBoundary extends React.Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="fatal-error" role="alert">
        <div className="fatal-error-card">
          <Info24Regular aria-hidden="true" />
          <p>ONEComputer</p>
          <h1>This page could not be displayed</h1>
          <span>No action was applied. Reload the page, or contact support if the problem continues.</span>
          <button className="primary-button" type="button" onClick={() => window.location.reload()}>Reload page</button>
        </div>
      </main>
    );
  }
}
