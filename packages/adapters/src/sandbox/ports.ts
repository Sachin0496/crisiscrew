import { parseOffset, type Customer, type ImportanceLevel, type Scenario, type Ticket } from "@crisiscrew/contracts";
import {
  hashSeed,
  mulberry32,
  type Clock,
  type Deployment,
  type ErrorRatePoint,
  type PaymentAttempt,
  type Ports,
  type ProviderHealth,
  type ServiceInfo,
} from "@crisiscrew/core";
import { e164 } from "../telephony/calls";
import { sandboxTelephony, type SandboxCall, type ScriptedCall } from "../telephony/sandbox";

const MINUTE = 60_000;
const SANDBOX = { mode: "sandbox" as const, adapter: "sandbox" };

export type SandboxOptions = {
  /** Epoch ms that the scenario's "+0s" maps to. */
  t0: number;
  clock: Clock;
  /** Pause per call so an audience can follow the agents; 0 in tests. */
  latencyMs: number;
};

export type SandboxRecord = {
  notes: { ticketId: string; text: string }[];
  replies: { ticketId: string; text: string }[];
  proactive: { customerRef: string; text: string }[];
  accountNotes: { id: string; customerRef: string; text: string }[];
  credits: { id: string; customerRefs: string[]; amountInr: number; reference: string }[];
  incidents: {
    id: string;
    incidentId: string;
    title: string;
    description: string;
    importance: ImportanceLevel;
    service?: string;
    tags: string[];
    notes: string[];
    change?: { id: string; title: string; description: string };
    problem?: { id: string; title: string; description: string };
  }[];
  calls: SandboxCall[];
};

/**
 * Every port backed by the scenario's world. The world knows which release
 * is faulty; the ports never reveal it. Metrics simulate its effect, the
 * same way a real service would show it.
 */
export function createSandboxPorts(scenario: Scenario, options: SandboxOptions): Ports & { record: SandboxRecord } {
  const { t0, clock, latencyMs } = options;
  const world = scenario.world;
  const pause = () => (latencyMs > 0 ? clock.sleep(latencyMs) : Promise.resolve());
  const at = (offset: string) => t0 + parseOffset(offset);
  const record: SandboxRecord = { notes: [], replies: [], proactive: [], accountNotes: [], credits: [], incidents: [], calls: [] };

  const deployments = world.deployments
    .map((d) => ({ ...d, atMs: at(d.at) }))
    .sort((a, b) => a.atMs - b.atMs);

  const customers = new Map<string, Customer>(
    world.customers.map((c) => [
      c.ref,
      { ref: c.ref, name: c.name, email: c.email, phone: c.phone, tier: c.tier, consent: { ...c.consent } },
    ]),
  );

  function errorRateAt(service: string, time: number): number {
    const info = world.services.find((s) => s.name === service);
    if (!info) return 0;
    const live = deployments.filter((d) => d.service === service && d.atMs <= time).at(-1);
    const base = live?.faulty ? info.faultyErrorRate : info.baselineErrorRate;
    const noise = mulberry32(hashSeed(`${scenario.id}:${service}:${Math.floor(time / MINUTE)}`))();
    return base * (1 + 0.2 * (noise - 0.5));
  }

  let creditCount = 0;

  return {
    record,

    deployments: {
      ...SANDBOX,
      async recent(service, sinceMs): Promise<Deployment[]> {
        await pause();
        const now = clock.now();
        return deployments
          .filter((d) => d.service === service && d.atMs >= sinceMs && d.atMs <= now)
          .reverse()
          .map((d) => ({
            service: d.service,
            version: d.version,
            sha: d.sha,
            author: d.author,
            at: d.atMs,
            message: d.message,
            environment: d.environment,
          }));
      },
    },

    payments: {
      ...SANDBOX,
      async health(): Promise<ProviderHealth[]> {
        await pause();
        return world.providers.map((p) => ({ provider: p.name, status: p.status, components: p.components, detail: p.detail }));
      },
    },

    metrics: {
      ...SANDBOX,
      async errorRates(service, fromMs, toMs): Promise<ErrorRatePoint[]> {
        await pause();
        const end = Math.min(toMs, clock.now());
        const points: ErrorRatePoint[] = [];
        for (let t = Math.ceil(fromMs / MINUTE) * MINUTE; t <= end; t += MINUTE) points.push({ at: t, rate: errorRateAt(service, t) });
        return points;
      },
    },

    orders: {
      ...SANDBOX,
      async attemptsSince(sinceMs): Promise<PaymentAttempt[]> {
        await pause();
        const now = clock.now();
        return world.attempts
          .map((a) => ({ customerRef: a.customerRef, at: at(a.at), method: a.method, status: a.status, amountInr: a.amountInr }))
          .filter((a) => a.at >= sinceMs && a.at <= now)
          .sort((a, b) => a.at - b.at);
      },
      async customer(ref) {
        return customers.get(ref) ?? null;
      },
      async findCustomer({ email, name }) {
        const wanted = email?.trim().toLowerCase();
        const named = name?.trim().toLowerCase();
        for (const c of customers.values()) {
          if (wanted && c.email?.toLowerCase() === wanted) return c;
        }
        for (const c of customers.values()) {
          if (named && c.name.toLowerCase() === named) return c;
        }
        return null;
      },
      async addAccountNote(customerRef, text) {
        await pause();
        const id = `NOTE-${String(record.accountNotes.length + 1).padStart(3, "0")}`;
        record.accountNotes.push({ id, customerRef, text });
        return { id };
      },
    },

    ticketActions: {
      ...SANDBOX,
      async addNote(ticket: Ticket, text: string) {
        await pause();
        record.notes.push({ ticketId: ticket.id, text });
      },
      async reply(ticket: Ticket, text: string) {
        await pause();
        record.replies.push({ ticketId: ticket.id, text });
      },
    },

    notifier: {
      ...SANDBOX,
      async proactive(customer, text) {
        await pause();
        record.proactive.push({ customerRef: customer.ref, text });
      },
    },

    voice: {
      mode: "off",
      adapter: "off",
      async synthesize() {
        return { audioId: null };
      },
    },

    telephony: sandboxTelephony({ seed: scenario.id, clock, record: record.calls, scripted: rosterOutcomes(world.oncall) }),

    // A service the scenario says nothing about is healthy: every pod ready, no alarms.
    infra: {
      ...SANDBOX,
      async health(service, sinceMs) {
        await pause();
        const info = world.infra[service];
        const now = clock.now();
        const alarms = (info?.alarms ?? [])
          .map((a) => ({ name: a.name, since: at(a.at), ...(a.metric ? { metric: a.metric } : {}) }))
          .filter((a) => a.since >= sinceMs && a.since <= now);
        const pods = info?.pods ?? { ready: 3, total: 3, restarts: 0, crashLooping: 0 };
        return {
          service,
          pods,
          alarms,
          ...(info?.cpuPercent !== undefined ? { cpuPercent: info.cpuPercent } : {}),
          checks: [
            { source: "sandbox", kind: "pods", checked: true, detail: `${pods.ready}/${pods.total} ready` },
            { source: "sandbox", kind: "alarms", checked: true, detail: `${alarms.length} active` },
            ...(info?.cpuPercent !== undefined ? [{ source: "sandbox", kind: "cpu" as const, checked: true, detail: `${info.cpuPercent}%` }] : []),
          ],
        };
      },
    },

    // The scenario's roster is on call for every service.
    oncall: {
      ...SANDBOX,
      async whoIsOnCall() {
        await pause();
        const order = { primary: 0, secondary: 1, tertiary: 2 };
        return [...world.oncall].sort((a, b) => order[a.role] - order[b.role]).map((r) => ({ name: r.name, role: r.role, phone: r.phone, ...(r.email ? { email: r.email } : {}) }));
      },
    },

    credits: {
      ...SANDBOX,
      async issue(customerRefs, amountInr, reference) {
        await pause();
        creditCount += 1;
        const id = `CR-${String(creditCount).padStart(3, "0")}`;
        record.credits.push({ id, customerRefs, amountInr, reference });
        return { id };
      },
    },

    incidents: {
      ...SANDBOX,
      async open({ incidentId, title, description, importance, service, tags }) {
        await pause();
        const id = `ENG-${String(record.incidents.length + 1).padStart(3, "0")}`;
        record.incidents.push({ id, incidentId, title, description, importance, ...(service ? { service } : {}), tags: tags ?? [], notes: [] });
        return { id };
      },
      async requestChange(recordId, { title, description }) {
        await pause();
        const found = record.incidents.find((i) => i.id === recordId);
        if (!found) throw new Error(`no engineering incident ${recordId}`);
        found.change = { id: `CHG-${recordId.slice(4)}`, title, description };
        return { id: found.change.id };
      },
      async openProblem(recordId, { title, description }) {
        await pause();
        const found = record.incidents.find((i) => i.id === recordId);
        if (!found) throw new Error(`no engineering incident ${recordId}`);
        found.problem = { id: `PRB-${recordId.slice(4)}`, title, description };
        return { id: found.problem.id };
      },
      async setImportance(recordId, importance) {
        await pause();
        const found = record.incidents.find((i) => i.id === recordId);
        if (!found) throw new Error(`no engineering incident ${recordId}`);
        found.importance = importance;
      },
      async note(recordId, text) {
        await pause();
        const found = record.incidents.find((i) => i.id === recordId);
        if (!found) throw new Error(`no engineering incident ${recordId}`);
        found.notes.push(text);
      },
    },

    catalog: {
      servicesFor(surface): ServiceInfo[] {
        return world.services.filter((s) => s.surfaces.includes(surface as never)).map((s) => ({ name: s.name, surfaces: s.surfaces }));
      },
    },
  };
}

/** What each responder on the roster does when called, as the sandbox telephone plays it. */
function rosterOutcomes(roster: Scenario["world"]["oncall"]): Map<string, ScriptedCall> {
  const outcomes: Record<(typeof roster)[number]["answers"], ScriptedCall> = {
    acknowledges: { outcome: "completed", digits: "1" },
    ignores: { outcome: "completed" },
    no_answer: { outcome: "no_answer" },
    busy: { outcome: "busy" },
  };
  return new Map(roster.map((r) => [e164(r.phone), outcomes[r.answers]]));
}
