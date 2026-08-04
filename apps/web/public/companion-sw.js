const VERSION = "onecomputer-companion-sw-0.2";
const COMPANION_PATH = "/companion?from=notification";
const OPEN_APPROVALS_MESSAGE = { type: "onecomputer-open-approvals" };

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(Promise.all([
    self.clients.claim(),
    caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key)))),
  ]));
});

self.addEventListener("push", (event) => {
  let validHint = false;
  try {
    const payload = event.data?.json();
    validHint = payload?.version === "1"
      && payload?.event === "approval-pending"
      && Object.keys(payload).length === 2;
  } catch {
    validHint = false;
  }
  if (!validHint) return;
  event.waitUntil(self.registration.showNotification("Approval requested", {
    body: "Open LemmaComputer Companion to review a protected action.",
    tag: "onecomputer-approval-pending",
    renotify: true,
    requireInteraction: true,
    data: { path: COMPANION_PATH, version: VERSION },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((client) => new URL(client.url).pathname === "/companion");
    if (existing) {
      existing.postMessage(OPEN_APPROVALS_MESSAGE);
      await existing.focus();
      try {
        return await existing.navigate(COMPANION_PATH);
      } catch {
        return existing;
      }
    }
    return self.clients.openWindow(COMPANION_PATH);
  })());
});
