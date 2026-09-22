import { z } from "zod";

export const Channel = z.enum(["chat", "email", "phone", "portal"]);
export type Channel = z.infer<typeof Channel>;

export const Surface = z.enum([
  "checkout_payments",
  "login_account",
  "delivery_orders",
  "refunds_billing",
  "app_performance",
  "other",
]);
export type Surface = z.infer<typeof Surface>;

export const SURFACE_LABELS: Record<Surface, string> = {
  checkout_payments: "Checkout & payments",
  login_account: "Login & account",
  delivery_orders: "Delivery & orders",
  refunds_billing: "Refunds & billing",
  app_performance: "App performance",
  other: "Other",
};

export const TicketInput = z.object({
  customerRef: z.string().min(1),
  customerName: z.string().min(1),
  channel: Channel,
  subject: z.string().optional(),
  body: z.string().trim().min(1).max(2000),
  receivedAt: z.number().int().optional(),
  externalId: z.string().optional(),
});
export type TicketInput = z.infer<typeof TicketInput>;

export type TicketSource = "sandbox" | "manual" | "freshdesk";
export type Ticket = TicketInput & { id: string; source: TicketSource; receivedAt: number };

export type Entities = { paymentMethods: string[]; amounts: number[]; orderIds: string[] };

export type SignalView = {
  ticketId: string;
  surface: Surface;
  surfaceScore: number;
  failureScore: number;
  isFailure: boolean;
  entities: Entities;
};

export type GateName = "size" | "cohesion" | "failure_share" | "burst";
export type GateResult = { name: GateName; value: number; threshold: number; pass: boolean; reason: string };

export type ClusterView = {
  id: string;
  memberTicketIds: string[];
  /** Mean pairwise similarity: semanticWeight x meaning + (1 - semanticWeight) x area. */
  cohesion: number;
  cohesionParts: { meaning: number; area: number };
  failureShare: number;
  failureCount: number;
  spanSec: number;
  burstP: number;
  baselinePerHour: number;
  dominantSurface: Surface;
  gates: GateResult[];
  fires: boolean;
  firstAt: number;
  lastAt: number;
};

export const Identity = z.enum(["pattern", "commander", "investigator", "recovery", "handoff", "operator"]);
export type Identity = z.infer<typeof Identity>;
export type AgentId = Exclude<Identity, "operator">;
export const AGENT_IDS: readonly AgentId[] = ["pattern", "commander", "investigator", "recovery", "handoff"];

export type Level = 0 | 1 | 2 | 3;
export const LEVEL_NAMES: Record<Level, string> = {
  0: "L0 read",
  1: "L1 limited write",
  2: "L2 customer contact",
  3: "L3 human approval",
};

export type AuditEntry = {
  seq: number;
  at: number;
  identity: Identity;
  tool: string;
  level: Level | null;
  argsSummary: string;
  decision: "allowed" | "denied";
  reason?: string;
  outcome?: "ok" | "error";
  resultSummary?: string;
  adapter: string;
  durationMs: number;
  prevHash: string;
  hash: string;
};

export type EvidenceItem = {
  source: string;
  observation: string;
  lr: number;
  adapter: string;
  checked: boolean;
};

export type HypothesisKind = "deploy" | "provider" | "unknown";
export type Hypothesis = {
  id: string;
  kind: HypothesisKind;
  subject: string;
  label: string;
  prior: number;
  evidence: EvidenceItem[];
  score: number;
  confidence: number;
};

export type Customer = {
  ref: string;
  name: string;
  email?: string;
  phone?: string;
  tier: "standard" | "priority";
  consent: { voice: boolean; proactive: boolean };
};

export type UpdateChannel = "ticket_reply" | "proactive_message" | "voice";
export type CustomerUpdate = {
  id: string;
  incidentId: string;
  customerRef: string;
  customerName: string;
  channel: UpdateChannel;
  text: string;
  source: string;
  status: "sent" | "refused";
  adapter: string;
  audioId?: string | null;
  reason?: string;
};

export type ApprovalStatus = "pending" | "approved" | "modified" | "rejected";
export type Approval = {
  id: string;
  incidentId: string;
  action: "issue_recovery_credit";
  amountInr: number;
  limitInr: number;
  perCustomerInr: number;
  customers: number;
  rationale: string;
  caseSummary: string;
  status: ApprovalStatus;
  requestedAt: number;
  approvedAmountInr?: number;
  decidedBy?: string;
  decidedAt?: number;
  note?: string;
};

export type IncidentStatus =
  | "detected"
  | "investigating"
  | "root_cause_identified"
  | "recovering"
  | "awaiting_approval"
  | "mitigated"
  | "resolved"
  | "dismissed";
export type Severity = "high" | "medium";

export type CreditState = {
  amountInr: number;
  perCustomerInr: number;
  customers: number;
  status: "proposed" | "awaiting_approval" | "issued" | "withheld";
  approvalId?: string;
};

export type IncidentView = {
  id: string;
  status: IncidentStatus;
  severity: Severity;
  openedAt: number;
  surface: Surface;
  clusterId: string;
  ticketIds: string[];
  linkedTicketIds: string[];
  hypotheses: Hypothesis[];
  rootCause?: { hypothesisId: string; label: string; confidence: number };
  narrative?: string;
  affected?: { ticketed: string[]; silent: string[]; total: number; since: number };
  updates: CustomerUpdate[];
  approvalId?: string;
  credit?: CreditState;
  timeline: { at: number; status: IncidentStatus; note: string }[];
};

export type AgentStatus = "idle" | "working" | "done";
export type AgentView = {
  id: AgentId;
  name: string;
  level: Level;
  status: AgentStatus;
  task?: string;
  lastTool?: string;
};
