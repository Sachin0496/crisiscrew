import { parseOffset, type AlertView, type Customer, type Scenario, type Ticket } from "@crisiscrew/contracts";
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
  incidents: { id: string; incidentId: string; title: string; description: string; notes: string[] }[];
  /** Alerts pushed out to a monitoring tool's integration endpoint. */
  alerts: { resource: string; severity: string; message: string; description?: string; additional_info?: Record<string, string> }[];
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
  const record: SandboxRecord = { notes: [], replies: [], proactive: [], accountNotes: [], credits: [], incidents: [], alerts: [] };

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
      async open({ incidentId, title, description }) {
        await pause();
        const id = `ENG-${String(record.incidents.length + 1).padStart(3, "0")}`;
        record.incidents.push({ id, incidentId, title, description, notes: [] });
        return { id };
      },
      async note(recordId, text) {
        await pause();
        const found = record.incidents.find((i) => i.id === recordId);
        if (!found) throw new Error(`no engineering incident ${recordId}`);
        found.notes.push(text);
      },
    },

    /**
     * The monitoring tool's view of the same world: a service whose live
     * release is faulty raises a critical alert, exactly as a real monitoring
     * tool would after the same deploy. This is what the investigator reads.
     */
    alerts: {
      ...SANDBOX,
      async active(sinceMs, options): Promise<AlertView[]> {
        await pause();
        const now = clock.now();
        if (sinceMs > now) return [];
        const fired = deployments.filter((d) => d.atMs >= sinceMs && d.atMs <= now && d.faulty);
        const stillFaulty = deployments.filter((d) => d.atMs <= now).at(-1);
        const out: AlertView[] = [];
        for (const d of fired) {
          const info = world.services.find((s) => s.name === d.service);
          const rate = info?.faultyErrorRate ?? 0;
          const open = stillFaulty?.service !== d.service || stillFaulty.faulty;
          if (!open && !options?.includeResolved) continue;
          out.push({
            id: `AMS-${d.service}-${d.sha.slice(0, 7)}`,
            source: "sandbox",
            receivedAt: now,
            severity: open ? "critical" : "ok",
            resource: d.service,
            hostname: d.service,
            metric: "error_rate",
            message: open
              ? `${d.service} error rate ${(rate * 100).toFixed(2)}% after ${d.version}`
              : `${d.service} recovered`,
            description: `${d.service} ${d.version} (${d.sha.slice(0, 7)} by ${d.author}) deployed ${new Date(d.atMs).toISOString()}: ${d.message}`,
            at: d.atMs,
            attributes: { service: d.service, version: d.version, error_rate: String(rate), environment: d.environment },
          });
        }
        return out;
      },
      async push(alert) {
        await pause();
        record.alerts.push({ ...alert });
        return { ok: true };
      },
    },

    catalog: {
      servicesFor(surface): ServiceInfo[] {
        return world.services.filter((s) => s.surfaces.includes(surface as never)).map((s) => ({ name: s.name, surfaces: s.surfaces }));
      },
    },
  };
}
