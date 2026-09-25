import { recoveryCoverage, SURFACE_LABELS, type CrisisState, type FixView, type IncidentView } from "@crisiscrew/contracts";

type IncidentSummary = {
  id: string;
  title: string;
  surface: string;
  status: string;
  trigger: string;
  openedAt: number;
  importance: string | null;
  page: boolean;
  importanceWhy: string[];
  rootCause: { label: string; confidence: number } | null;
  engineering: { id: string; url: string | null; change: string | null; problem: string | null } | null;
  paging: { status: string; by: string | null; via: string | null; attempts: { responder: string; role: string; state: string }[] } | null;
  complaintsLinked: number;
  coverage: ReturnType<typeof recoveryCoverage>;
  outreach: { replies: number; proactive: number; voice: number; notes: number; acknowledgements: number };
  credits: { auto: number; awaiting: number; decided: number; autoInr: number };
  approvals: { customer: string; amountInr: number }[];
  customers: { name: string; complained: boolean; confirmed: boolean; amountInr: number; tier: string; recovered: boolean }[];
};

/** What the cockpit shows of CrisisCrew's own state: every incident, where each ticket went, and the Fix Agent's work. */
export type CrisisSummary = {
  connected: boolean;
  error?: string;
  session?: { mode: string; title?: string; startedAt?: number };
  agents: Record<string, { status: string; task?: string; name?: string }>;
  tickets: number;
  /** Each CrisisCrew ticket: the Freshdesk ticket it came from, and the incident the Pattern Agent put it in. */
  routes: { id: string; externalId: string | null; incidentId: string | null; isFailure: boolean | null; surface: string | null }[];
  candidate: { reports: number; members: number } | null;
  incidents: IncidentSummary[];
  /** The incident the story is about: the most important one. */
  incident: IncidentSummary | null;
  fix: FixView | null;
  calls: { id: string; purpose: string; state: string; transcript: { speaker: string; text: string; at: number }[] }[];
  audit: { seq: number; identity: string; tool: string; decision: string; level: number | null; summary: string }[];
};

const count = (incident: IncidentView, kinds: string[], statuses?: string[]) =>
  incident.actions.filter((a) => kinds.includes(a.kind) && (!statuses || statuses.includes(a.status))).length;

const RANK: Record<string, number> = { P1: 1, P2: 2, P3: 3 };

function incidentSummary(state: CrisisState, incident: IncidentView): IncidentSummary {
  const pending = Object.values(state.approvals).filter((a) => a.incidentId === incident.id && a.status === "pending");
  const coverage = recoveryCoverage(incident);
  const credits = incident.actions.filter((a) => a.kind === "credit");
  return {
    id: incident.id,
    title: SURFACE_LABELS[incident.surface],
    surface: incident.surface,
    status: incident.status,
    trigger: incident.trigger ?? "complaints",
    openedAt: incident.openedAt,
    importance: incident.importance?.level ?? null,
    page: incident.importance?.page ?? false,
    importanceWhy: (incident.importance?.reasons ?? []).map((r) => r.text),
    rootCause: incident.rootCause ? { label: incident.rootCause.label, confidence: incident.rootCause.confidence } : null,
    engineering: incident.engineering
      ? { id: incident.engineering.id, url: incident.engineering.url ?? null, change: incident.engineering.change?.id ?? null, problem: incident.engineering.problem?.id ?? null }
      : null,
    paging: incident.paging
      ? { status: incident.paging.status, by: incident.paging.acknowledgedBy ?? null, via: incident.paging.via ?? null, attempts: incident.paging.attempts.map((a) => ({ responder: a.responder, role: a.role, state: a.state })) }
      : null,
    complaintsLinked: new Set([...incident.ticketIds, ...incident.linkedTicketIds]).size,
    coverage,
    outreach: {
      replies: count(incident, ["ticket_reply"], ["done"]),
      acknowledgements: count(incident, ["acknowledge"], ["done"]),
      proactive: count(incident, ["proactive_message"], ["done"]),
      voice: count(incident, ["voice"]),
      notes: count(incident, ["account_note"], ["done"]),
    },
    credits: {
      auto: credits.filter((a) => a.status === "done" && !a.approvalId).length,
      awaiting: credits.filter((a) => a.status === "awaiting_approval").length,
      decided: credits.filter((a) => a.approvalId && a.status !== "awaiting_approval").length,
      autoInr: credits.filter((a) => a.status === "done" && !a.approvalId).reduce((s, a) => s + (a.amountInr ?? 0), 0),
    },
    approvals: pending.map((a) => ({ customer: a.customerName, amountInr: a.amountInr })),
    customers: (incident.impact?.customers ?? []).map((c) => {
      const actions = incident.actions.filter((a) => a.customerRef === c.ref);
      return {
        name: c.name,
        complained: c.complained,
        confirmed: c.confidence === "confirmed",
        amountInr: c.amountInr,
        tier: c.tier,
        recovered: actions.length > 0 && actions.every((a) => ["done", "prepared", "unreached", "declined"].includes(a.status)),
      };
    }),
  };
}

export function summarize(state: CrisisState): CrisisSummary {
  const incidents = state.incidentOrder.map((id) => incidentSummary(state, state.incidents[id]!));
  const main = [...incidents].sort((a, b) => (RANK[a.importance ?? "P3"] ?? 3) - (RANK[b.importance ?? "P3"] ?? 3) || a.openedAt - b.openedAt)[0] ?? null;
  return {
    connected: true,
    session: { mode: state.session.mode, startedAt: state.session.startedAt, ...(state.session.scenarioTitle ? { title: state.session.scenarioTitle } : {}) },
    agents: Object.fromEntries(Object.values(state.agents).map((a) => [a.id, { status: a.status, name: a.name, ...(a.task ? { task: a.task } : {}) }])),
    tickets: state.ticketOrder.length,
    routes: state.ticketOrder.map((id) => {
      const view = state.tickets[id]!;
      return { id, externalId: view.ticket.externalId ?? null, incidentId: view.incidentId ?? null, isFailure: view.signal?.isFailure ?? null, surface: view.signal?.surface ?? null };
    }),
    candidate: state.candidate ? { reports: state.candidate.reportTicketIds.length, members: state.candidate.memberTicketIds.length } : null,
    incidents,
    incident: main,
    fix: main ? (state.fixes?.[main.id] ?? null) : null,
    calls: Object.values(state.calls).map((c) => ({ id: c.id, purpose: c.purpose, state: c.state, transcript: c.transcript ?? [] })),
    audit: state.toolCalls.slice(-40).map((e) => ({ seq: e.seq, identity: e.identity, tool: e.tool, decision: e.decision, level: e.level, summary: e.resultSummary ?? e.reason ?? "" })),
  };
}

/** Reads CrisisCrew's state every so often, so the cockpit can show what the agents decided. */
export class CrisisWatcher {
  latest: CrisisSummary = { connected: false, agents: {}, tickets: 0, routes: [], candidate: null, incidents: [], incident: null, fix: null, calls: [], audit: [] };
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly url: string,
    private readonly onChange: () => void,
    private readonly doFetch: typeof fetch = fetch,
  ) {}

  start(everyMs = 500): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), everyMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async poll(): Promise<void> {
    let next: CrisisSummary;
    try {
      const res = await this.doFetch(`${this.url}/api/state`, { signal: AbortSignal.timeout(2_000) });
      if (!res.ok) throw new Error(`answered ${res.status}`);
      next = summarize((await res.json()) as CrisisState);
    } catch (error) {
      next = { ...this.latest, connected: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (JSON.stringify(next) !== JSON.stringify(this.latest)) {
      this.latest = next;
      this.onChange();
    }
  }
}
