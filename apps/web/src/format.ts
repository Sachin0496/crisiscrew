import { SURFACE_LABELS, type AgentStatus, type CreditState, type IncidentStatus, type PortMode, type PortName, type Severity, type Surface } from "@crisiscrew/contracts";

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
  mitigated: "Mitigated",
  resolved: "Resolved",
  dismissed: "Dismissed",
};

export const STATUS_TONE: Record<IncidentStatus, Tone> = {
  detected: "danger",
  investigating: "accent",
  root_cause_identified: "accent",
  recovering: "accent",
  awaiting_approval: "warning",
  mitigated: "success",
  resolved: "success",
  dismissed: "neutral",
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

export const CREDIT_STATUS: Record<CreditState["status"], string> = {
  proposed: "proposed",
  awaiting_approval: "awaiting approval",
  issued: "issued",
  withheld: "withheld by the approver",
};

export const PORT_LABELS: Record<PortName, string> = {
  tickets: "Tickets",
  deployments: "Deployments",
  payments: "Payment health",
  metrics: "Metrics",
  orders: "Orders",
  voice: "Voice",
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

export const TOOL_OWNER: Record<string, string> = {
  pattern: "Pattern Agent",
  commander: "Commander",
  investigator: "Investigator",
  recovery: "Recovery",
  handoff: "Handoff",
  operator: "MCP client",
};
