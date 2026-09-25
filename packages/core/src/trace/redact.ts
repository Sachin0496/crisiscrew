/**
 * Redaction for anything that leaves the engine as a log or a trace:
 * secrets always, and customers' contact and payment details. Names and
 * customer refs stay, so a trace can still be read.
 */

const RULES: [RegExp, string | ((match: string) => string)][] = [
  // Secrets: bearer tokens, API keys with a known prefix, long hex or base64url strings.
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]"],
  [/\b(?:sk|pk|lsk|lsv2|ls|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{12,}\b/g, "[redacted key]"],
  [/\b[a-f0-9]{32,}\b/gi, "[redacted token]"],
  // Emails and UPI ids (name@bank): keep the first character and the domain, so the shape is still readable.
  // The domain must start with a letter, so hypothesis ids like "deploy:checkout-service@4.21.7" stay intact.
  [/\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)*)\b/g, (m) => m.replace(/^(.)[^@]*@/, "$1***@")],
  // Card numbers: 13 to 19 digits, optionally grouped. Keep the last four.
  [/\b(?:\d[ -]?){12,18}\d\b/g, (m) => `[card ••${m.replace(/\D/g, "").slice(-4)}]`],
  // Indian phone numbers (+91, then 10 digits starting 6-9) and other long phone-like numbers.
  [/(?:\+91[\s-]?)?\b[6-9]\d{4}[\s-]?\d{5}\b/g, "[phone]"],
  // PAN (ABCDE1234F) and Aadhaar-like 12-digit groups.
  [/\b[A-Z]{5}\d{4}[A-Z]\b/g, "[PAN]"],
  [/\b\d{4}\s\d{4}\s\d{4}\b/g, "[ID number]"],
];

export function redactText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement as string);
  return out;
}

const SECRET_KEYS = /(^|_)(api[-_]?key|token|secret|password|authorization|cookie)$/i;

/** Deep copy with every string redacted and secret-named fields removed. */
export function redact(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEYS.test(k) ? "[redacted]" : redact(v);
    return out;
  }
  return value;
}

const MAX_STRING = 600;
const MAX_ITEMS = 25;
const MAX_DEPTH = 6;

/**
 * Keeps a trace payload small enough to store and send: long strings are
 * clipped, long arrays are cut with a count of what was left out, deep
 * nesting is summarised, and Maps, Sets and typed arrays become plain values.
 */
export function compact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING - 1)}…` : value;
  if (typeof value === "number") return Number.isFinite(value) ? Number(value.toPrecision(6)) : String(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") return String(value);
  if (ArrayBuffer.isView(value)) return `[${(value as unknown as { length: number }).length} numbers]`;
  if (depth >= MAX_DEPTH) return Array.isArray(value) ? `[${value.length} items]` : "{…}";
  if (value instanceof Map) return compact(Object.fromEntries(value), depth);
  if (value instanceof Set) return compact([...value], depth);
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((v) => compact(v, depth + 1));
    return value.length > MAX_ITEMS ? [...items, `… ${value.length - MAX_ITEMS} more`] : items;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v !== undefined) out[k] = compact(v, depth + 1);
  }
  return out;
}
