const agentChatTurnPathPattern = /^\/v1\/workspaces\/[^/]+\/chat\/agents\/[^/]+\/sessions\/[^/]+\/messages\/?$/;

export const ordinaryControlRequestTimeoutMs = 30_000;
export const agentChatControlRequestTimeoutMs = 16 * 60_000;

export const controlRequestTimeout = (
  method,
  pathname,
  ordinaryTimeoutMs = ordinaryControlRequestTimeoutMs,
  agentChatTimeoutMs = agentChatControlRequestTimeoutMs,
) => method === "POST" && agentChatTurnPathPattern.test(pathname)
  ? agentChatTimeoutMs
  : ordinaryTimeoutMs;
