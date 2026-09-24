/**
 * The small HTTP layer shared by the Freshdesk and Freshservice adapters:
 * API-key Basic auth, JSON, a timeout under the policy gate's 5 seconds, and
 * errors that say what Freshworks answered.
 */

export type FreshworksAuth = {
  /** e.g. "acme.freshdesk.com" */
  domain: string;
  apiKey: string;
  /** Injected in tests; the global fetch otherwise. */
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export class FreshworksError extends Error {
  override name = "FreshworksError";
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterSec?: number,
  ) {
    super(message);
  }
}

/**
 * Accepts "acme", "acme.freshdesk.com" or "https://acme.freshdesk.com/" and
 * returns the bare host. A name without a dot gets the product's domain.
 */
export function normalizeDomain(input: string, productDomain: "freshdesk.com" | "freshservice.com"): string {
  const host = input
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
  if (!host) throw new Error("empty domain");
  return host.includes(".") ? host : `${host}.${productDomain}`;
}

function describe(body: string): string {
  try {
    const json = JSON.parse(body) as { description?: string; message?: string; errors?: { field?: string; message?: string }[] };
    const errors = (json.errors ?? []).map((e) => [e.field, e.message].filter(Boolean).join(": ")).filter(Boolean);
    return [json.description ?? json.message, ...errors].filter(Boolean).join("; ");
  } catch {
    return body.slice(0, 200);
  }
}

export async function freshworksRequest<T>(auth: FreshworksAuth, method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
  const doFetch = auth.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`https://${auth.domain}${path}`, {
      method,
      headers: {
        authorization: `Basic ${Buffer.from(`${auth.apiKey}:X`).toString("base64")}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(auth.timeoutMs ?? 4_000),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new FreshworksError(0, `${auth.domain} ${method} ${path} did not answer: ${reason}`);
  }
  if (!res.ok) {
    const detail = describe(await res.text().catch(() => ""));
    const retry = res.headers.get("retry-after");
    throw new FreshworksError(
      res.status,
      `${auth.domain} ${method} ${path} failed with ${res.status}${detail ? `: ${detail}` : ""}${retry ? ` (retry after ${retry} s)` : ""}`,
      retry ? Number(retry) : undefined,
    );
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Plain text to the HTML that Freshworks note, reply and description bodies expect. */
export function textToHtml(text: string): string {
  return text
    .replace(/[&<>"']/g, (ch) => ESCAPES[ch]!)
    .split(/\r?\n/)
    .join("<br>");
}

/** HTML from a ticket description back to plain text, for when description_text is missing. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}
