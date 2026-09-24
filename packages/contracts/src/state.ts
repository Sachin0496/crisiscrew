import type {
  AgentId,
  AgentView,
  Approval,
  AuditEntry,
  ClusterView,
  IncidentView,
  SignalView,
  Ticket,
} from "./domain";
import type { CrisisEvent, SessionMode } from "./events";

export const TOOL_CALL_CAP = 300;

export type TicketView = { ticket: Ticket; signal?: SignalView; incidentId?: string };

export type CreditRecord = {
  id: string;
  incidentId: string;
  customerRef: string;
  amountInr: number;
  approvalId?: string;
  adapter: string;
  at: number;
};

export type CrisisState = {
  seq: number;
  session: { id: string; mode: SessionMode; scenarioId?: string; scenarioTitle?: string; speed?: number; startedAt: number };
  tickets: Record<string, TicketView>;
  ticketOrder: string[];
  candidate: ClusterView | null;
  incidents: Record<string, IncidentView>;
  incidentOrder: string[];
  agents: Record<AgentId, AgentView>;
  toolCalls: AuditEntry[];
  approvals: Record<string, Approval>;
  credits: CreditRecord[];
  replayFinished: boolean;
};

const DEFAULT_AGENTS: Record<AgentId, AgentView> = {
  pattern: { id: "pattern", name: "Pattern Agent", level: 0, status: "idle" },
  commander: { id: "commander", name: "Incident Commander", level: 1, status: "idle" },
  investigator: { id: "investigator", name: "Investigator", level: 0, status: "idle" },
  recovery: { id: "recovery", name: "Recovery Agent", level: 2, status: "idle" },
  handoff: { id: "handoff", name: "Handoff Agent", level: 3, status: "idle" },
};

export function initialState(): CrisisState {
  return {
    seq: 0,
    session: { id: "", mode: "idle", startedAt: 0 },
    tickets: {},
    ticketOrder: [],
    candidate: null,
    incidents: {},
    incidentOrder: [],
    agents: { ...DEFAULT_AGENTS },
    toolCalls: [],
    approvals: {},
    credits: [],
    replayFinished: false,
  };
}

function updateIncident(state: CrisisState, id: string, change: (incident: IncidentView) => IncidentView): CrisisState {
  const incident = state.incidents[id];
  if (!incident) return state;
  return { ...state, incidents: { ...state.incidents, [id]: change(incident) } };
}

function markTickets(state: CrisisState, ticketIds: string[], incidentId: string): Record<string, TicketView> {
  const tickets = { ...state.tickets };
  for (const id of ticketIds) {
    const view = tickets[id];
    if (view) tickets[id] = { ...view, incidentId };
  }
  return tickets;
}

/** Applies one event to the state. The server and the web UI share this function. */
export function reduce(previous: CrisisState, event: CrisisEvent): CrisisState {
  const state = { ...previous, seq: event.seq };

  switch (event.type) {
    case "session.started": {
      const fresh = initialState();
      const agents = { ...fresh.agents };
      for (const a of event.payload.agents) agents[a.id] = { id: a.id, name: a.name, level: a.level, status: "idle" };
      const { sessionId, mode, scenarioId, scenarioTitle, speed } = event.payload;
      return {
        ...fresh,
        seq: event.seq,
        agents,
        session: { id: sessionId, mode, scenarioId, scenarioTitle, speed, startedAt: event.at },
      };
    }

    case "ticket.received": {
      const { ticket } = event.payload;
      if (state.tickets[ticket.id]) return state;
      return {
        ...state,
        tickets: { ...state.tickets, [ticket.id]: { ticket } },
        ticketOrder: [...state.ticketOrder, ticket.id],
      };
    }

    case "signal.scored": {
      const { signal } = event.payload;
      const view = state.tickets[signal.ticketId];
      if (!view) return state;
      return { ...state, tickets: { ...state.tickets, [signal.ticketId]: { ...view, signal } } };
    }

    case "cluster.updated":
      return { ...state, candidate: event.payload.cluster };

    case "incident.opened": {
      const { incident } = event.payload;
      return {
        ...state,
        incidents: { ...state.incidents, [incident.id]: incident },
        incidentOrder: [...state.incidentOrder, incident.id],
        tickets: markTickets(state, incident.ticketIds, incident.id),
      };
    }

    case "incident.status_changed": {
      const { incidentId, to, note } = event.payload;
      return updateIncident(state, incidentId, (incident) => ({
        ...incident,
        status: to,
        timeline: [...incident.timeline, { at: event.at, status: to, note }],
      }));
    }

    case "agent.status": {
      const { agent, status, task } = event.payload;
      const current = state.agents[agent];
      return { ...state, agents: { ...state.agents, [agent]: { ...current, status, task } } };
    }

    case "tool.called": {
      const { entry } = event.payload;
      const toolCalls = [...state.toolCalls, entry].slice(-TOOL_CALL_CAP);
      const agents = { ...state.agents };
      if (entry.identity !== "operator") {
        const agent = agents[entry.identity];
        agents[entry.identity] = { ...agent, lastTool: entry.tool };
      }
      return { ...state, toolCalls, agents };
    }

    case "rootcause.ranked": {
      const { incidentId, hypotheses, rootCause, narrative } = event.payload;
      return updateIncident(state, incidentId, (incident) => ({ ...incident, hypotheses, rootCause, narrative }));
    }

    case "ticket.linked": {
      const { incidentId, ticketId } = event.payload;
      const next = updateIncident(state, incidentId, (incident) =>
        incident.linkedTicketIds.includes(ticketId)
          ? incident
          : { ...incident, linkedTicketIds: [...incident.linkedTicketIds, ticketId] },
      );
      return { ...next, tickets: markTickets(next, [ticketId], incidentId) };
    }

    case "impact.assessed": {
      const { incidentId, impact } = event.payload;
      return updateIncident(state, incidentId, (incident) => ({ ...incident, impact }));
    }

    case "recovery.planned": {
      const { incidentId, actions } = event.payload;
      return updateIncident(state, incidentId, (incident) => {
        const known = new Set(incident.actions.map((a) => a.id));
        return { ...incident, actions: [...incident.actions, ...actions.filter((a) => !known.has(a.id))] };
      });
    }

    case "recovery.updated": {
      const { incidentId, action } = event.payload;
      return updateIncident(state, incidentId, (incident) => ({
        ...incident,
        actions: incident.actions.map((a) => (a.id === action.id ? action : a)),
      }));
    }

    case "update.sent": {
      const { update } = event.payload;
      return updateIncident(state, update.incidentId, (incident) => ({ ...incident, updates: [...incident.updates, update] }));
    }

    case "approval.requested":
    case "approval.decided": {
      const { approval } = event.payload;
      return { ...state, approvals: { ...state.approvals, [approval.id]: approval } };
    }

    case "credit.issued": {
      const { incidentId, customerRef, amountInr, approvalId, adapter, creditId } = event.payload;
      return {
        ...state,
        credits: [...state.credits, { id: creditId, incidentId, customerRef, amountInr, approvalId, adapter, at: event.at }],
      };
    }

    case "engineering.recorded": {
      const { incidentId, record } = event.payload;
      return updateIncident(state, incidentId, (incident) => ({ ...incident, engineering: record }));
    }

    case "replay.finished":
      return { ...state, replayFinished: true };
  }
}
