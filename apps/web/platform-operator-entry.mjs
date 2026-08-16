const platformOperatorUiPath = "/api/v1/platform/ui";

export const platformOperatorEntryRedirect = (method, requestUrl) => {
  if (!new Set(["GET", "HEAD"]).has(method ?? "")) return null;
  const url = new URL(requestUrl ?? "/", "http://lemmacomputer.invalid");
  if (url.pathname !== "/platform" && url.pathname !== "/platform/") return null;
  return `${platformOperatorUiPath}${url.search}`;
};
