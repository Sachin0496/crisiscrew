import { screenText } from "./injection";

/**
 * The output guard for anything sent to a customer. Today the text comes
 * from fixed templates; once a language model drafts it, this is the check
 * that keeps a model from promising money nobody approved, linking anywhere,
 * leaking another customer's details or echoing injected instructions.
 * Deterministic, so the gate can refuse with a reason.
 */

export type OutboundContext = {
  /** Amounts this customer may be told about: their planned or approved credit. */
  allowedAmountsInr: number[];
  /** Hosts an update may link to. Empty: no links at all. */
  allowedHosts: string[];
  /** This customer's own contact details, which the text may contain. */
  ownContacts: string[];
};

const AMOUNT = /(?:₹|\brs\.?\s?|\binr\s?)\s?(\d[\d,]*(?:\.\d+)?)/gi;
const URL = /\bhttps?:\/\/([^\s/?#]+)[^\s]*/gi;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z][A-Za-z0-9.-]*\.[A-Za-z]{2,}\b/g;
const PHONE = /(?:\+91[\s-]?)?\b[6-9]\d{4}[\s-]?\d{5}\b/g;

/** Returns why the text may not be sent, or null when it may. */
export function checkOutbound(text: string, ctx: OutboundContext): string | null {
  for (const m of text.matchAll(AMOUNT)) {
    const amount = Number(m[1]!.replace(/,/g, ""));
    if (!ctx.allowedAmountsInr.includes(amount)) return `the message mentions ₹${amount.toLocaleString("en-IN")}, which nobody approved for this customer`;
  }
  for (const m of text.matchAll(URL)) {
    const host = m[1]!.toLowerCase();
    if (!ctx.allowedHosts.some((h) => host === h || host.endsWith(`.${h}`))) return `the message links to ${host}, which isn't on the allow-list`;
  }
  const own = new Set(ctx.ownContacts.map((c) => c.toLowerCase().replace(/[\s-]/g, "")));
  for (const m of [...text.matchAll(EMAIL), ...text.matchAll(PHONE)]) {
    if (!own.has(m[0].toLowerCase().replace(/[\s-]/g, ""))) return "the message contains contact details that aren't this customer's";
  }
  const verdict = screenText(text);
  if (verdict.flagged) return `the message contains instruction-like text (${verdict.reasons.join(", ")})`;
  return null;
}
