import { request as httpsRequest } from "node:https";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type MutualTlsFetchConfig = {
  ca: string;
  clientCertificate: string;
  clientKey: string;
  serverName: string;
};

const bodyBuffer = async (body: BodyInit | null | undefined): Promise<Buffer | undefined> => {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof Blob) return Buffer.from(await body.arrayBuffer());
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new TypeError("The mutual-TLS transport only accepts buffered request bodies");
};

const requestHeaders = (headers: HeadersInit | undefined, body: Buffer | undefined) => {
  const normalized = new Headers(headers);
  const values: Record<string, string> = {};
  normalized.forEach((value, name) => { values[name] = value; });
  if (body && !normalized.has("content-length")) values["content-length"] = String(body.byteLength);
  return values;
};

const responseHeaders = (headers: Record<string, string | string[] | undefined>) => {
  const normalized = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) for (const item of value) normalized.append(name, item);
    else if (value !== undefined) normalized.set(name, value);
  }
  return normalized;
};

/**
 * Node's global fetch does not accept a client certificate. Keep the mTLS
 * transport small and explicit so every LiteLLM administration request proves
 * the Control workload identity and validates the proxy certificate chain.
 */
export const createMutualTlsFetch = (config: MutualTlsFetchConfig): FetchLike => async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.toString());
  if (url.protocol !== "https:") throw new TypeError("Mutual-TLS requests require an HTTPS URL");
  const body = await bodyBuffer(init.body);
  const headers = requestHeaders(init.headers, body);
  if (init.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      init.signal?.removeEventListener("abort", abort);
      callback();
    };
    const request = httpsRequest(url, {
      method: init.method ?? "GET",
      headers,
      ca: config.ca,
      cert: config.clientCertificate,
      key: config.clientKey,
      servername: config.serverName,
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.once("error", (error) => finish(() => reject(error)));
      response.once("end", () => finish(() => {
        try {
          resolve(new Response(chunks.length ? Buffer.concat(chunks) : null, {
            status: response.statusCode ?? 502,
            statusText: response.statusMessage,
            headers: responseHeaders(response.headers),
          }));
        } catch (error) {
          reject(error);
        }
      }));
    });
    const abort = () => finish(() => {
      request.destroy(new DOMException("The operation was aborted", "AbortError"));
      reject(new DOMException("The operation was aborted", "AbortError"));
    });
    request.once("error", (error) => finish(() => reject(error)));
    init.signal?.addEventListener("abort", abort, { once: true });
    request.end(body);
  });
};
