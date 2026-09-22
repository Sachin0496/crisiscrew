import { SURFACE_LABELS, type IncidentStatus, type Surface } from "@crisiscrew/contracts";

export const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
export const pct = (x: number, digits = 0) => `${(x * 100).toFixed(digits)}%`;
export const surface = (s: Surface) => SURFACE_LABELS[s];

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
  recovering: "Recovering customers",
  awaiting_approval: "Waiting for a human",
  mitigated: "Mitigated",
  resolved: "Resolved",
  dismissed: "Dismissed",
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
