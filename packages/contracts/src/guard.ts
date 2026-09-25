/**
 * Guardrails on untrusted text. Tickets, tool outputs from external systems
 * and anything a model might write are data, never instructions: a guard
 * screens them for instruction-like content before any language model could
 * see them, and flags what it finds. A flag never grants or blocks authority
 * on its own; the policy gate still decides every action.
 */

/** Where the screened text came from. */
export type GuardSource = "ticket" | "tool_output" | "customer_update";

export type GuardVerdict = {
  flagged: boolean;
  /** 0 to 1: how strongly the text tries to instruct an AI system. */
  score: number;
  /** Rule codes that matched, e.g. "override_instructions"; see GUARD_REASONS. */
  reasons: string[];
  /** The guard that decided: "heuristic" (built in) or "lakera". */
  guard: string;
  /** Short excerpts that matched, for the audit trail. */
  matches: string[];
};

/** A flagged input, shown on the Governance page and in the trace where it happened. */
export type GuardFlag = {
  at: number;
  source: GuardSource;
  /** What was screened: a ticket id, or the tool whose output it was. */
  ref: string;
  verdict: GuardVerdict;
  excerpt: string;
};

export const GUARD_REASONS: Record<string, string> = {
  override_instructions: "Tries to override the system's instructions",
  role_hijack: "Tries to change the assistant's role",
  prompt_exfiltration: "Asks for the system prompt, keys or other secrets",
  tool_invocation: "Names an internal tool or asks for a function call",
  authority_claim: "Claims an authority or approval it can't prove",
  money_directive: "Tells the system to move money",
  hidden_text: "Hides text with invisible or direction-changing characters",
  prompt_markup: "Contains chat-template or system-prompt markup",
  code_injection: "Contains an SQL or script payload",
  encoded_payload: "Contains a long encoded blob",
  unapproved_amount: "Mentions an amount nobody approved",
  unapproved_link: "Links to a site that isn't allowed",
  other_customer: "Mentions another customer's details",
};

/** The ticket types a classifier may assign. Only a failure report counts toward an incident. */
export type TicketType = "failure" | "question" | "request";

/** How a ticket was classified: by the built-in embedding prototypes, or by Laya, with its confidence. */
export type ClassifierInfo = {
  source: string;
  /** The model or checkpoint that answered, e.g. Laya's "english". */
  model?: string;
  ticketType: TicketType;
  /** Probability of the chosen ticket type. Absent for the built-in classifier, which gives a margin, not a probability. */
  confidence?: number;
  /** Probability of the chosen product area, when the classifier gives one. */
  surfaceConfidence?: number;
  latencyMs?: number;
  /** Set when the configured classifier failed and the built-in one answered instead. */
  fallback?: string;
};
