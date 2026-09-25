import type { AlertView } from "./alerts";
import type {
  AgentId,
  AgentStatus,
  Approval,
  AuditEntry,
  ClusterView,
  CustomerImpact,
  CustomerUpdate,
  EngineeringRecord,
  Hypothesis,
  IncidentStatus,
  IncidentView,
  Level,
  RecoveryAction,
  SignalView,
  Ticket,
} from "./domain";

type E<T extends string, P> = { seq: number; at: number; type: T; payload: P };

export type SessionMode = "idle" | "replay" | "live";

export type CrisisEvent =
  | E<
      "session.started",
      {
        sessionId: string;
        mode: SessionMode;
        scenarioId?: string;
        scenarioTitle?: string;
        speed?: number;
        agents: { id: AgentId; name: string; level: Level }[];
      }
    >
  | E<"ticket.received", { ticket: Ticket }>
  | E<"signal.scored", { signal: SignalView; nearest: { ticketId: string; similarity: number }[] }>
  | E<"cluster.updated", { cluster: ClusterView }>
  | E<"incident.opened", { incident: IncidentView }>
  | E<"incident.status_changed", { incidentId: string; from: IncidentStatus; to: IncidentStatus; note: string }>
  | E<"agent.status", { agent: AgentId; status: AgentStatus; task?: string }>
  | E<"tool.called", { entry: AuditEntry }>
  | E<
      "rootcause.ranked",
      {
        incidentId: string;
        hypotheses: Hypothesis[];
        rootCause?: { hypothesisId: string; label: string; confidence: number };
        narrative?: string;
      }
    >
  | E<"ticket.linked", { incidentId: string; ticketId: string }>
  /** The customer impact graph, as last assessed: every affected customer with their evidence. */
  | E<"impact.assessed", { incidentId: string; impact: CustomerImpact }>
  /** New recovery actions; actions already planned are never replaced by this event. */
  | E<"recovery.planned", { incidentId: string; actions: RecoveryAction[] }>
  /** One action's new status. */
  | E<"recovery.updated", { incidentId: string; action: RecoveryAction }>
  | E<"update.sent", { update: CustomerUpdate }>
  | E<"approval.requested", { approval: Approval }>
  | E<"approval.decided", { approval: Approval }>
  | E<"credit.issued", { incidentId: string; customerRef: string; amountInr: number; approvalId?: string; adapter: string; creditId: string }>
  | E<"engineering.recorded", { incidentId: string; record: EngineeringRecord }>
  /** The incident was raised as an alert in Freshservice Alert Management. */
  | E<"alert.raised", { incidentId: string; severity: string; message: string; adapter: string }>
  /** An alert arrived from a monitoring tool on CrisisCrew's inbound webhook. */
  | E<"alert.received", { alert: AlertView }>
  /** The incident's alert was resolved because every affected customer recovered. */
  | E<"alert.resolved", { incidentId: string; adapter: string }>
  | E<"replay.finished", { scenarioId: string }>;

export type CrisisEventType = CrisisEvent["type"];

/** An event before the bus assigns its sequence number and timestamp. */
export type EventInput = CrisisEvent extends infer Ev ? (Ev extends CrisisEvent ? Omit<Ev, "seq" | "at"> : never) : never;
