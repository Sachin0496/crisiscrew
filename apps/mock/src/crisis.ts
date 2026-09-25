import { recoveryCoverage, type CrisisState, type IncidentView } from "@crisiscrew/contracts";

/** What the demo view shows of CrisisCrew's own state: the latest incident and each agent's step, in a few numbers. */
export type CrisisSummary = {
  connected: boolean;
  error?: string;
  session?: { mode: string; title?: string };
  agents: Record<string, { status: string; task?: string }>;
  tickets: number;
  candidate: { reports: number; members: number } | null;
  incident: {
    id: string;
    status: string;
    trigger: string;
    importance: string | null;
    importanceWhy: string[];
    rootCause: { label: string; confidence: number } | null;
    engineering: { id: string; change: string | null; problem: string | null } | null;
    paging: { status: string; by: string | null; attempts: { responder: string; state: string }[] } | null;
    complaintsLinked: number;
    coverage: ReturnType<typeof recoveryCoverage>;
    outreach: { replies: number; proactive: number; voice: number; notes: number };
    credits: { auto: number; awaiting: number; decided: number };
    approvals: { customer: string; amountInr: number }[];
  } | null;
};

const count = (incident: IncidentView, kinds: string[], statuses?: string[]) =>
  incident.actions.filter((a) => kinds.includes(a.kind) && (!statuses || statuses.includes(a.status))).length;

export function summarize(state: CrisisState): CrisisSummary {
  const id = state.incidentOrder.at(-1);
  const incident = id ? state.incidents[id] : undefined;
  const pending = Object.values(state.approvals).filter((a) => a.incidentId === id && a.status === "pending");
  return {
    connected: true,
    session: { mode: state.session.mode, ...(state.session.scenarioTitle ? { title: state.session.scenarioTitle } : {}) },
    agents: Object.fromEntries(Object.values(state.agents).map((a) => [a.id, { status: a.status, ...(a.task ? { task: a.task } : {}) }])),
    tickets: state.ticketOrder.length,
    candidate: state.candidate ? { reports: state.candidate.reportTicketIds.length, members: state.candidate.memberTicketIds.length } : null,
    incident: incident
      ? {
          id: incident.id,
          status: incident.status,
          trigger: incident.trigger ?? "complaints",
          importance: incident.importance?.level ?? null,
          importanceWhy: (incident.importance?.reasons ?? []).map((r) => r.text),
          rootCause: incident.rootCause ? { label: incident.rootCause.label, confidence: incident.rootCause.confidence } : null,
          engineering: incident.engineering ? { id: incident.engineering.id, change: incident.engineering.change?.id ?? null, problem: incident.engineering.problem?.id ?? null } : null,
          paging: incident.paging
            ? { status: incident.paging.status, by: incident.paging.acknowledgedBy ?? null, attempts: incident.paging.attempts.map((a) => ({ responder: a.responder, state: a.state })) }
            : null,
          complaintsLinked: new Set([...incident.ticketIds, ...incident.linkedTicketIds]).size,
          coverage: recoveryCoverage(incident),
          outreach: {
            replies: count(incident, ["ticket_reply", "acknowledge"], ["done"]),
            proactive: count(incident, ["proactive_message"], ["done"]),
            voice: count(incident, ["voice"]),
            notes: count(incident, ["account_note"], ["done"]),
          },
          credits: {
            auto: incident.actions.filter((a) => a.kind === "credit" && a.status === "done" && !a.approvalId).length,
            awaiting: count(incident, ["credit"], ["awaiting_approval"]),
            decided: incident.actions.filter((a) => a.kind === "credit" && a.approvalId && a.status !== "awaiting_approval").length,
          },
          approvals: pending.map((a) => ({ customer: a.customerName, amountInr: a.amountInr })),
        }
      : null,
  };
}

/** Reads CrisisCrew's state every so often, so the demo view can show what the agents decided. */
export class CrisisWatcher {
  latest: CrisisSummary = { connected: false, agents: {}, tickets: 0, candidate: null, incident: null };
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly url: string,
    private readonly onChange: () => void,
    private readonly doFetch: typeof fetch = fetch,
  ) {}

  start(everyMs = 1_000): void {
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
      next = { connected: false, error: error instanceof Error ? error.message : String(error), agents: {}, tickets: 0, candidate: null, incident: null };
    }
    if (JSON.stringify(next) !== JSON.stringify(this.latest)) {
      this.latest = next;
      this.onChange();
    }
  }
}
