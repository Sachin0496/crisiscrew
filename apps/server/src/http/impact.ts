import {
  actionsFor,
  customerState,
  incidentTitle,
  recoveryCoverage,
  type Coverage,
  type CrisisState,
  type CustomerRecoveryState,
  type EngineeringRecord,
  type EvidenceEdge,
  type IncidentStatus,
  type RecoveryAction,
  type TicketView,
} from "@crisiscrew/contracts";

/** What the Freshdesk sidebar (and GET /api/tickets/:id/impact) shows for one ticket. */
export type TicketImpact =
  | { tracked: false; message: string }
  | {
      tracked: true;
      ticket: { id: string; externalId?: string; customerName: string; receivedAt: number; reportsFailure: boolean | null };
      incident: null | {
        id: string;
        title: string;
        status: IncidentStatus;
        rootCause: { label: string; confidence: number } | null;
        coverage: Coverage;
        engineering: EngineeringRecord | null;
      };
      customer: null | {
        ref: string;
        name: string;
        confidence: "confirmed" | "unverified";
        complained: boolean;
        severity: string | null;
        state: CustomerRecoveryState;
        evidence: EvidenceEdge[];
        actions: RecoveryAction[];
      };
      pendingApproval: { id: string; amountInr: number } | null;
      /** Where the full evidence chain is, in the CrisisCrew console. */
      consoleUrl: string;
    };

export function ticketImpact(state: CrisisState, view: TicketView | undefined, baseUrl: string): TicketImpact {
  if (!view) return { tracked: false, message: "CrisisCrew hasn't seen this ticket in the current session." };
  const { ticket } = view;
  const incident = view.incidentId ? state.incidents[view.incidentId] : undefined;
  const customer = incident?.impact?.customers.find((c) => c.ref === ticket.customerRef);
  const actions = incident && customer ? actionsFor(incident, customer.ref) : [];
  const pending = Object.values(state.approvals).find((a) => a.incidentId === incident?.id && a.customerRef === ticket.customerRef && a.status === "pending");
  return {
    tracked: true,
    ticket: {
      id: ticket.id,
      ...(ticket.externalId ? { externalId: ticket.externalId } : {}),
      customerName: ticket.customerName,
      receivedAt: ticket.receivedAt,
      reportsFailure: view.signal ? view.signal.isFailure : null,
    },
    incident: incident
      ? {
          id: incident.id,
          title: incidentTitle(incident.surface),
          status: incident.status,
          rootCause: incident.rootCause ? { label: incident.rootCause.label, confidence: incident.rootCause.confidence } : null,
          coverage: recoveryCoverage(incident),
          engineering: incident.engineering ?? null,
        }
      : null,
    customer: customer
      ? {
          ref: customer.ref,
          name: customer.name,
          confidence: customer.confidence,
          complained: customer.complained,
          severity: customer.severity ?? null,
          state: customerState(customer, actions),
          evidence: customer.evidence,
          actions,
        }
      : null,
    pendingApproval: pending ? { id: pending.id, amountInr: pending.amountInr } : null,
    consoleUrl: customer ? `${baseUrl}/#/customers/${encodeURIComponent(customer.ref)}` : `${baseUrl}/#/incident`,
  };
}
