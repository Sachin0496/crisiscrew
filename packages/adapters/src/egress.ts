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

/** A fetch that refuses any host off the allow-list, and plain HTTP except to a listed loopback host. */
export function allowListedFetch(allowed: readonly string[], inner: typeof fetch = fetch): typeof fetch {
  const guarded = async (input: string | URL | Request, init?: RequestInit) => {
    const url = urlOf(input);
    if (!hostAllowed(url, allowed)) throw new EgressError(`${url.host} is not on the egress allow-list (${allowed.join(", ") || "empty"})`);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
      throw new EgressError(`${url.protocol.replace(":", "")} to ${url.host} is not allowed; use https`);
    }
    return inner(input, init);
  };
  return guarded as typeof fetch;
}

/** The host (with its port, when it has one) of a configured base URL, for the allow-list. */
export function hostOf(baseUrl: string): string {
  return new URL(baseUrl).host;
}
