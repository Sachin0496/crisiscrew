import { ScenarioSchema, type Scenario } from "@crisiscrew/contracts";
import { readFileSync } from "node:fs";

const SCENARIO_DIR = new URL("../../../scenarios/", import.meta.url);

/** The scenario CrisisCrew's live session runs on (LIVE_WORLD, as the server reads it): its customers are the ones Freshdesk tickets are matched to. */
export const LIVE_WORLD = process.env.LIVE_WORLD || "checkout-autofix";

export function loadScenario(id: string): Scenario {
  const parsed = ScenarioSchema.safeParse(JSON.parse(readFileSync(new URL(`${id}.json`, SCENARIO_DIR), "utf8")));
  if (!parsed.success) throw new Error(`Invalid scenario ${id}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return parsed.data;
}

/** What a phone number does when the mock rings it on autopilot: the scenario's own behaviour for that person. */
export type PhoneBehaviour = { answers: "answers" | "no_answer" | "busy"; press?: string };

export type Person = { name: string; email?: string; phone?: string; kind: "customer" | "oncall"; role?: string; tier?: string };

const digits = (phone: string) => phone.replace(/\D/g, "");

/** The people behind the numbers and emails the mock will see, from the live world. */
export class World {
  readonly scenario: Scenario;
  readonly people: Person[];
  private readonly behaviours = new Map<string, PhoneBehaviour>();

  constructor(scenario: Scenario = loadScenario(LIVE_WORLD)) {
    this.scenario = scenario;
    this.people = [
      ...scenario.world.customers.map((c) => ({
        name: c.name,
        kind: "customer" as const,
        tier: c.tier,
        ...(c.email ? { email: c.email } : {}),
        ...(c.phone ? { phone: c.phone } : {}),
      })),
      ...scenario.world.oncall.map((r) => ({ name: r.name, kind: "oncall" as const, role: r.role, phone: r.phone, ...(r.email ? { email: r.email } : {}) })),
    ];
    for (const c of scenario.world.customers) {
      if (c.phone && c.onCall) this.behaviours.set(digits(c.phone), { answers: c.onCall.answers, ...(c.onCall.press ? { press: c.onCall.press } : {}) });
    }
    for (const r of scenario.world.oncall) {
      const b: PhoneBehaviour =
        r.answers === "acknowledges" ? { answers: "answers", press: "1" } : r.answers === "ignores" ? { answers: "answers" } : { answers: r.answers };
      this.behaviours.set(digits(r.phone), b);
    }
  }

  /** Who a number belongs to, if anyone in the world. */
  byPhone(phone: string): Person | undefined {
    const d = digits(phone);
    return this.people.find((p) => p.phone && digits(p.phone) === d);
  }

  /** What the person at this number says on a conversational call, turn by turn, when the scenario scripts it. */
  conversation(phone: string): string[] | undefined {
    const d = digits(phone);
    return this.scenario.world.oncall.find((r) => digits(r.phone) === d)?.conversation;
  }

  /** How a number answers on autopilot. Numbers the scenario doesn't describe answer and press 1. */
  behaviour(phone: string): PhoneBehaviour {
    return this.behaviours.get(digits(phone)) ?? { answers: "answers", press: "1" };
  }

  /** The on-call roster, as Freshservice On-Call Management's shift events. */
  shiftEvents() {
    return this.scenario.world.oncall.map((r, i) => ({
      id: 9000 + i,
      roster_type: r.role.toUpperCase(),
      user: { id: 5000 + i, name: r.name, email: r.email ?? null, mobile: r.phone, phone: null },
    }));
  }

  /** The scenario's complaints, as a customer would file them in Freshdesk. */
  complaints(): { atMs: number; name: string; email: string; channel: string; body: string; subject?: string }[] {
    const customers = new Map(this.scenario.world.customers.map((c) => [c.ref, c]));
    return this.scenario.tickets.map((t) => {
      const c = customers.get(t.customerRef)!;
      return {
        atMs: offsetMs(t.at),
        name: c.name,
        email: c.email ?? `${c.name.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "")}@example.com`,
        channel: t.channel,
        body: t.body,
        ...(t.subject ? { subject: t.subject } : {}),
      };
    });
  }
}

function offsetMs(text: string): number {
  const m = /^([+-]?)(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(text.trim());
  if (!m) return 0;
  const unit = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[m[3] as "ms" | "s" | "m" | "h"];
  return (m[1] === "-" ? -1 : 1) * Number(m[2]) * unit;
}

/** Alerts worth firing by hand, from the scenarios that have them. */
export function alertPresets(): { label: string; service: string; metric: string; value?: string; threshold?: string; severity: "critical" | "warning" }[] {
  const presets = [];
  for (const id of ["alert-before-complaints", "noisy-alert"]) {
    try {
      for (const a of loadScenario(id).world.alerts) {
        presets.push({ label: a.label, service: a.service, metric: a.metric, severity: a.severity, ...(a.value ? { value: a.value } : {}), ...(a.threshold ? { threshold: a.threshold } : {}) });
      }
    } catch {
      // a missing scenario only means fewer presets
    }
  }
  return presets;
}
