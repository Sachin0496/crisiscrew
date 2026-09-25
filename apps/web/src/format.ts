import {
  SURFACE_LABELS,
  type AgentStatus,
  type CustomerRecoveryState,
  type EvidenceKind,
  type ImportanceLevel,
  type IncidentStatus,
  type PortMode,
  type PortName,
  type RecoveryKind,
  type RecoveryStatus,
  type Severity,
  type Surface,
} from "@crisiscrew/contracts";

/** Badge and callout colours: neutral, or one of the meaningful roles. */
export type Tone = "neutral" | "accent" | "danger" | "warning" | "success";

export const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
export const pct = (x: number, digits = 0) => `${(x * 100).toFixed(digits)}%`;
export const surface = (s: Surface) => SURFACE_LABELS[s];
/** "1 ticket", "2 tickets"; pass the plural when adding "s" is wrong. */
export const plural = (n: number, singular: string, pluralForm = `${singular}s`) => `${n} ${n === 1 ? singular : pluralForm}`;
/** Capitalises the first letter, for engine phrases shown on their own. */
export const sentence = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

export function initials(name: string): string {
  const parts = name.replace(/[^\p{L}\s]/gu, "").trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

/** Clock time of day, as the audience's laptop shows it. */
export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

/** Time since the session started, e.g. +1:05. */
export function since(ms: number, start: number): string {
  const s = Math.max(0, Math.round((ms - start) / 1000));
  return `+${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export const STATUS_LABELS: Record<IncidentStatus, string> = {
  detected: "Detected",
  investigating: "Investigating",
  root_cause_identified: "Root cause identified",
  recovering: "Recovering",
  awaiting_approval: "Awaiting approval",
  recovered: "Recovered",
  resolved: "Resolved",
  dismissed: "Dismissed",
};

export const STATUS_TONE: Record<IncidentStatus, Tone> = {
  detected: "danger",
  investigating: "accent",
  root_cause_identified: "accent",
  recovering: "accent",
  awaiting_approval: "warning",
  recovered: "success",
  resolved: "success",
  dismissed: "neutral",
};

export const IMPORTANCE: Record<ImportanceLevel, { tone: Tone; meaning: string }> = {
  P1: { tone: "danger", meaning: "urgent: page the on-call engineer" },
  P2: { tone: "warning", meaning: "high: engineering acts today" },
  P3: { tone: "neutral", meaning: "normal: working hours" },
};

export const SEVERITY: Record<Severity, { label: string; tone: Tone }> = {
  high: { label: "High severity", tone: "danger" },
  medium: { label: "Medium severity", tone: "warning" },
};

export const AGENT_STATUS: Record<AgentStatus, { label: string; tone: Tone }> = {
  idle: { label: "Idle", tone: "neutral" },
  working: { label: "Working", tone: "accent" },
  done: { label: "Done", tone: "success" },
};

export const CUSTOMER_STATE: Record<CustomerRecoveryState, { label: string; tone: Tone }> = {
  recovered: { label: "Recovered", tone: "success" },
  needs_human: { label: "Needs a human", tone: "warning" },
  in_progress: { label: "In progress", tone: "accent" },
  attention: { label: "Needs attention", tone: "danger" },
  unverified: { label: "Not verified", tone: "neutral" },
};

export const RECOVERY_KIND: Record<RecoveryKind, string> = {
  ticket_reply: "Reply on their ticket",
  acknowledge: "Acknowledgement",
  proactive_message: "Proactive message",
  voice: "Voice update",
  account_note: "Account note",
  credit: "Goodwill credit",
  no_credit: "No credit",
};

/** Short names for the recovery chips in tables. */
export const RECOVERY_CHIP: Record<RecoveryKind, string> = {
  ticket_reply: "Reply",
  acknowledge: "Acknowledge",
  proactive_message: "Message",
  voice: "Voice",
  account_note: "Account note",
  credit: "Credit",
  no_credit: "No credit",
};

export const RECOVERY_STATUS: Record<RecoveryStatus, { label: string; tone: Tone }> = {
  planned: { label: "Planned", tone: "neutral" },
  done: { label: "Done", tone: "success" },
  prepared: { label: "Prepared", tone: "neutral" },
  awaiting_approval: { label: "Waiting for approval", tone: "warning" },
  declined: { label: "Declined", tone: "neutral" },
  failed: { label: "Failed", tone: "danger" },
};

export const EVIDENCE_SOURCE: Record<string, string> = {
  sandbox: "Sandbox",
  engine: "Engine",
  manual: "Typed here",
  freshdesk: "Freshdesk",
};

export const EVIDENCE_TITLE: Record<EvidenceKind, string> = {
  payment_failed: "Payment failed",
  payment_pending: "Payment stuck",
  payment_succeeded: "Paid on retry",
  service: "Service",
  cause: "Cause",
  window: "Incident window",
  reported: "Contacted support",
  no_ticket: "Stayed silent",
  no_payment: "No payment evidence",
};

export const PORT_LABELS: Record<PortName, string> = {
  tickets: "Tickets",
  incidents: "Engineering incidents",
  deployments: "Deployments",
  payments: "Payment health",
  metrics: "Metrics",
  orders: "Orders",
  voice: "Voice",
  telephony: "Phone calls",
  llm: "Language model",
  embeddings: "Embeddings",
  credits: "Credits",
  translate: "Translation",
};

export const MODE: Record<PortMode, { label: string; tone: Tone }> = {
  live: { label: "Live", tone: "success" },
  sandbox: { label: "Sandbox", tone: "neutral" },
  off: { label: "Off", tone: "neutral" },
};

export const GATE_LABELS = { size: "Size", cohesion: "Similarity", failure_share: "Failure share", burst: "Burst" } as const;

export const CHANNEL_LABELS = { ticket_reply: "Ticket reply", proactive_message: "Proactive message", voice: "Voice" } as const;

/** Adapter names as the console shows them. */
export const ADAPTER_LABELS: Record<string, string> = {
  sandbox: "Sandbox",
  core: "Engine",
  off: "Off",
  freshdesk: "Freshdesk",
  "freshdesk-mcp": "Freshdesk MCP",
  freshservice: "Freshservice",
};

export const TOOL_OWNER: Record<string, string> = {
  pattern: "Pattern Agent",
  commander: "Commander",
  investigator: "Investigator",
  recovery: "Recovery",
  handoff: "Handoff",
  operator: "MCP client",
};
