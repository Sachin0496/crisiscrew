/**
 * The egress allow-list: every outbound call CrisisCrew makes to a model or
 * observability service goes through a fetch that only reaches configured
 * hosts. HTTPS only, except plain HTTP to a loopback host that is listed
 * explicitly (a self-hosted Laya server on localhost). A URL that came from
 * data (a ticket, a tool output) can't point it anywhere else, which is the
 * SSRF guard. The Freshworks adapters are already pinned to their product
 * domains by normalizeDomain.
 */

export class EgressError extends Error {
  override name = "EgressError";
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Private, link-local and metadata-service addresses: never reachable unless listed exactly. */
function isPrivateAddress(host: string): boolean {
  if (LOOPBACK.has(host)) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0;
  }
  return host.startsWith("[") || host.endsWith(".internal") || host.endsWith(".local");
}

/** True when the host is an allowed entry or a subdomain of one. Entries may carry a port ("localhost:8000"). */
export function hostAllowed(url: URL, allowed: readonly string[]): boolean {
  const host = url.hostname.toLowerCase();
  return allowed.some((entry) => {
    const [name, port] = entry.toLowerCase().split(/:(?=\d+$)/);
    if (port && url.port !== port) return false;
    if (isPrivateAddress(host)) return host === name;
    return host === name || host.endsWith(`.${name}`);
  });
}

function urlOf(input: string | URL | Request): URL {
  if (input instanceof URL) return input;
  return new URL(typeof input === "string" ? input : input.url);
}

/** A fetch that checks every redirect hop against the allow-list. */
export function allowListedFetch(allowed: readonly string[], inner: typeof fetch = fetch): typeof fetch {
  const guarded = async (input: string | URL | Request, init?: RequestInit) => {
    let request = new Request(input, init);
    for (let redirects = 0; ; redirects += 1) {
      const url = urlOf(request);
      if (!hostAllowed(url, allowed)) throw new EgressError(`${url.host} is not on the egress allow-list (${allowed.join(", ") || "empty"})`);
      if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
        throw new EgressError(`${url.protocol.replace(":", "")} to ${url.host} is not allowed; use https`);
      }
      const response = await inner(request.clone(), { redirect: "manual" });
      if (![301, 302, 303, 307, 308].includes(response.status) || !response.headers.has("location")) return response;
      if (request.redirect === "manual") return response;
      if (request.redirect === "error") throw new TypeError("Redirect is not allowed");
      if (redirects >= 20) throw new TypeError("Too many redirects");

      const target = new URL(response.headers.get("location")!, url);
      // Preserve fetch's method rewrite and remove credentials on an origin change.
      const rewrite = response.status === 303 && request.method !== "HEAD"
        || (response.status === 301 || response.status === 302) && request.method === "POST";
      const headers = new Headers(request.headers);
      if (rewrite) {
        headers.delete("content-type");
        headers.delete("content-length");
      }
      if (target.origin !== url.origin) {
        headers.delete("authorization");
        headers.delete("cookie");
        headers.delete("proxy-authorization");
      }
      request = rewrite
        ? new Request(target, { method: "GET", headers, redirect: request.redirect, signal: request.signal })
        : new Request(target, request);
      if (!rewrite && target.origin !== url.origin) {
        request.headers.delete("authorization");
        request.headers.delete("cookie");
        request.headers.delete("proxy-authorization");
      }
      await response.body?.cancel();
    }
  };
  return guarded as typeof fetch;
}

/** The host (with its port, when it has one) of a configured base URL, for the allow-list. */
export function hostOf(baseUrl: string): string {
  return new URL(baseUrl).host;
}
