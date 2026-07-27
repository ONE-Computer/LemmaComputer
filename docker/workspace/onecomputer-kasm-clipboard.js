(() => {
  "use strict";

  const query = new URLSearchParams(window.location.search);
  const policyEnabled = query.get("onecomputer_clipboard") !== "disabled";
  const chromium = /\b(?:Chrom(?:e|ium)|Edg|Brave)\//.test(navigator.userAgent);
  const nativeApi = Boolean(
    window.isSecureContext
    && navigator.clipboard
    && typeof navigator.clipboard.readText === "function"
    && typeof navigator.clipboard.writeText === "function",
  );

  const status = document.createElement("div");
  status.id = "onecomputer-clipboard-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  Object.assign(status.style, {
    position: "fixed",
    zIndex: "2147483647",
    top: "16px",
    left: "50%",
    transform: "translateX(-50%)",
    maxWidth: "min(560px, calc(100vw - 32px))",
    padding: "10px 14px",
    border: "1px solid rgba(12, 52, 89, 0.28)",
    borderRadius: "6px",
    background: "rgba(244, 248, 252, 0.97)",
    boxShadow: "0 4px 18px rgba(10, 31, 51, 0.18)",
    color: "#17324d",
    font: "600 13px/1.4 system-ui, sans-serif",
  });
  document.body.append(status);

  let permissionState = "unknown";
  let hideTimer;

  const show = (message, persistent = true) => {
    window.clearTimeout(hideTimer);
    status.textContent = message;
    status.hidden = false;
    if (!persistent) hideTimer = window.setTimeout(() => { status.hidden = true; }, 6000);
  };

  const render = () => {
    if (!document.documentElement.classList.contains("noVNC_connected")) {
      show("Clipboard is waiting for the workspace connection.");
      return;
    }
    if (!policyEnabled) {
      show("Clipboard sharing is disabled by your ONEComputer workspace policy.");
      return;
    }
    if (!chromium || !nativeApi) {
      show("Native clipboard is unavailable in this browser. Use the Kasm clipboard panel as a fallback.");
      return;
    }
    if (permissionState === "denied") {
      show("Clipboard permission is blocked. Allow clipboard access for this workspace site, then reconnect.");
      return;
    }
    if (permissionState === "prompt") {
      show("Use Ctrl+V or Cmd+V and allow clipboard access if your browser asks.", false);
      return;
    }
    show("Native clipboard is ready. Use your normal copy and paste shortcuts.", false);
  };

  const connectionObserver = new MutationObserver(render);
  connectionObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

  if (policyEnabled && chromium && nativeApi && navigator.permissions?.query) {
    navigator.permissions.query({ name: "clipboard-read" })
      .then((permission) => {
        permissionState = permission.state;
        permission.addEventListener?.("change", () => {
          permissionState = permission.state;
          render();
        });
        render();
      })
      .catch(render);
  } else {
    render();
  }
})();
