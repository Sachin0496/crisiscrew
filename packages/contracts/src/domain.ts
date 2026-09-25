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

export const PaymentMethod = z.enum(["upi", "card", "netbanking", "wallet"]);
export type PaymentMethod = z.infer<typeof PaymentMethod>;

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = { upi: "UPI", card: "Card", netbanking: "Netbanking", wallet: "Wallet" };

export const SURFACE_LABELS: Record<Surface, string> = {
  checkout_payments: "Checkout & payments",
  login_account: "Login & account",
  delivery_orders: "Delivery & orders",
  refunds_billing: "Refunds & billing",
  app_performance: "App performance",
  other: "Other",
};

const INCIDENT_TITLES: Record<Surface, string> = {
  checkout_payments: "Checkout and payment failures",
  login_account: "Login and account failures",
  delivery_orders: "Delivery and order failures",
  refunds_billing: "Refund and billing failures",
  app_performance: "App performance failures",
  other: "Customer-reported failures",
};

/** An incident's headline, named after the product area that is failing. */
export const incidentTitle = (surface: Surface) => INCIDENT_TITLES[surface];

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
  /** The members that report a failure. An incident opens on these; questions in the group count toward the gates only. */
  reportTicketIds: string[];
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
  /** Set once the cluster belongs to an incident: when it opened one, or when a ticket joins one. */
  incidentId?: string;
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
  /** When this cause would have started (a release's time); used to date the impact. */
  startedAt?: number;
};

export type Customer = {
  ref: string;
  name: string;
  email?: string;
  phone?: string;
  tier: "standard" | "priority";
  consent: { voice: boolean; proactive: boolean };
};

/** Why a phone call is made: paging the on-call engineer, or calling an affected customer. */
export type CallPurpose = "oncall" | "customer";

/** A call's lifecycle. The last four are final. */
export type CallState = "queued" | "ringing" | "answered" | "completed" | "no_answer" | "busy" | "failed";

export const FINAL_CALL_STATES: readonly CallState[] = ["completed", "no_answer", "busy", "failed"];

/** One outbound phone call, as the telephony adapter last reported it. */
export type CallView = {
  id: string;
  purpose: CallPurpose;
  /** The number called, masked to its last four digits for display and logs. */
  to: string;
  state: CallState;
  adapter: string;
  startedAt: number;
  updatedAt: number;
  durationSec?: number;
  /** Keys the callee pressed, when the call asked for input. */
  digits?: string;
  /** Why a call failed or ended without an answer, in the provider's words. */
  reason?: string;
  metadata?: Record<string, string>;
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
  /** "prepared": a voice script was written but the voice port is off, so nothing was sent. */
  status: "sent" | "prepared" | "refused";
  adapter: string;
  audioId?: string | null;
  reason?: string;
  /** The recovery action this update carries out. */
  actionId?: string;
};

export type ApprovalStatus = "pending" | "approved" | "modified" | "rejected";
/** A human decision on one customer's credit that is above the agents' authority. */
export type Approval = {
  id: string;
  incidentId: string;
  action: "issue_recovery_credit";
  /** The recovery action the decision settles. */
  actionId: string;
  customerRef: string;
  customerName: string;
  amountInr: number;
  /** The largest credit the agents may give one customer on their own. */
  limitInr: number;
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
  | "recovered"
  | "resolved"
  | "dismissed";
export type Severity = "high" | "medium";

/** What links an affected customer to the incident: one readable sentence per edge of the impact graph. */
export type EvidenceKind =
  | "payment_failed"
  | "payment_pending"
  | "payment_succeeded"
  | "service"
  | "cause"
  | "window"
  | "reported"
  | "no_ticket"
  | "no_payment";

export type EvidenceEdge = {
  kind: EvidenceKind;
  label: string;
  /** The graph node this edge points to, e.g. "ticket:T-1004" or "service:checkout-service". */
  node: string;
  at?: number;
  /** The adapter that supplied the fact: "sandbox", "freshdesk", "engine". */
  source: string;
};

/** Confirmed: a failed or pending payment inside the incident window. Unverified: complained, but no such payment on record. */
export type ImpactConfidence = "confirmed" | "unverified";
export type ImpactSeverity = "high" | "medium" | "low";

export type AffectedCustomer = {
  ref: string;
  name: string;
  email?: string;
  tier: "standard" | "priority";
  consent: { proactive: boolean; voice: boolean };
  /** Filed a failure report that belongs to the incident. */
  complained: boolean;
  ticketIds: string[];
  confidence: ImpactConfidence;
  /** Absent when the customer isn't verified. */
  severity?: ImpactSeverity;
  failedAttempts: number;
  /** The largest failed or pending payment in the window; 0 when there's none. */
  amountInr: number;
  methods: PaymentMethod[];
  firstFailedAt?: number;
  lastFailedAt?: number;
  /** A later payment went through, so the customer got past the failure. */
  paidOnRetry: boolean;
  evidence: EvidenceEdge[];
};

export type CustomerImpact = {
  /** Start of the incident window. */
  since: number;
  /** When the evidence was last read. */
  assessedAt: number;
  customers: AffectedCustomer[];
};

/**
 * ticket_reply: the incident update, on the customer's own ticket. acknowledge: a reply to an unverified complaint asking for a
 * payment reference. no_credit: a recorded decision not to credit, with its reason.
 */
export type RecoveryKind = "ticket_reply" | "acknowledge" | "proactive_message" | "voice" | "account_note" | "credit" | "no_credit";
export type RecoveryStatus = "planned" | "done" | "prepared" | "awaiting_approval" | "declined" | "failed";

/** One step of one customer's recovery, with the reason the policy chose it. */
export type RecoveryAction = {
  id: string;
  incidentId: string;
  customerRef: string;
  kind: RecoveryKind;
  reason: string;
  /** The authority the action needs; null for a decision that calls no tool. */
  level: Level | null;
  amountInr?: number;
  status: RecoveryStatus;
  /** The outcome in a few words: an update or credit id, a refusal, who decided. */
  detail?: string;
  approvalId?: string;
  updatedAt: number;
};

/** Where one customer's recovery stands, derived from their actions. */
export type CustomerRecoveryState = "recovered" | "needs_human" | "in_progress" | "attention" | "unverified";

/** The engineering incident record (Freshservice, or its sandbox) that the operational side works from. */
export type EngineeringRecord = {
  id: string;
  url?: string;
  adapter: string;
  /** The importance the record's priority was last set from. */
  importance?: "P1" | "P2" | "P3";
};

/** How urgently engineering must act: P1 pages the on-call engineer, P3 can wait for working hours. */
export type ImportanceLevel = "P1" | "P2" | "P3";

/** One rule that raised an incident's importance, in plain words. */
export type ImportanceReason = { rule: string; level: ImportanceLevel; text: string };

/**
 * The Incident Commander's decision on how important an incident is, from
 * deterministic rules in policy.json. It only goes up on its own; a human
 * can set it either way, and then the rules stop changing it.
 */
export type ImportanceAssessment = {
  level: ImportanceLevel;
  /** Whether the on-call engineer should be paged. */
  page: boolean;
  reasons: ImportanceReason[];
  /** What the assessment knew: the incident opening, its customer impact, its root cause, or a human's decision. */
  stage: "opened" | "impact" | "root_cause" | "human";
  source: "rules" | "human";
  by?: string;
  note?: string;
  assessedAt: number;
};

/** Where a responder sits in the on-call schedule, in the order they're paged. */
export type OnCallRole = "primary" | "secondary" | "tertiary";

/**
 * One call to one on-call responder. calling: the phone is ringing or the
 * call is in progress; acknowledged: they pressed 1; not_acknowledged: they
 * answered but didn't press 1; the rest say why the call didn't connect.
 */
export type PageAttemptState = "calling" | "acknowledged" | "not_acknowledged" | "no_answer" | "busy" | "failed";

export type PageAttempt = {
  attempt: number;
  responder: string;
  role: OnCallRole;
  /** Masked to the last four digits. */
  phone: string;
  callId?: string;
  state: PageAttemptState;
  startedAt: number;
  updatedAt: number;
  reason?: string;
};

/**
 * Paging the on-call engineer for an incident. paging: a call is out or the
 * next one is due; acknowledged: someone took it; exhausted: every allowed
 * attempt went unacknowledged; no_responder: nobody on call could be called.
 */
export type PagingView = {
  status: "paging" | "acknowledged" | "exhausted" | "no_responder";
  attempts: PageAttempt[];
  acknowledgedBy?: string;
  acknowledgedAt?: number;
  /** How it was acknowledged: a key press on the call, or an operator (in CrisisCrew or Freshservice). */
  via?: "call" | "operator";
  note?: string;
};

export type IncidentView = {
  id: string;
  status: IncidentStatus;
  /** high for P1, medium otherwise; kept for readers that predate importance. */
  severity: Severity;
  importance?: ImportanceAssessment;
  paging?: PagingView;
  openedAt: number;
  surface: Surface;
  clusterId: string;
  ticketIds: string[];
  linkedTicketIds: string[];
  hypotheses: Hypothesis[];
  rootCause?: { hypothesisId: string; label: string; confidence: number };
  narrative?: string;
  impact?: CustomerImpact;
  actions: RecoveryAction[];
  updates: CustomerUpdate[];
  engineering?: EngineeringRecord;
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
