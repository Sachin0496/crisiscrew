import { z } from "zod";
import { Channel, PaymentMethod, Surface } from "./domain";

const OFFSET_PATTERN = /^([+-]?)(\d+(?:\.\d+)?)(ms|s|m|h)$/;
const UNIT_MS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const;

/** Parses a relative time such as "-14m", "+30s" or "2h" into milliseconds. */
export function parseOffset(text: string): number {
  const match = OFFSET_PATTERN.exec(text.trim());
  if (!match) throw new Error(`Invalid offset "${text}": use a number with ms, s, m or h, e.g. "-14m"`);
  const [, sign, amount, unit] = match;
  const ms = Number(amount) * UNIT_MS[unit as keyof typeof UNIT_MS];
  return sign === "-" ? -ms : ms;
}

const Offset = z.string().regex(OFFSET_PATTERN, "Use a relative time such as -14m or +30s");

export const ScenarioCustomer = z.object({
  ref: z.string().min(1),
  name: z.string().min(1),
  email: z.string().optional(),
  phone: z.string().optional(),
  tier: z.enum(["standard", "priority"]).default("standard"),
  consent: z
    .object({ voice: z.boolean().default(false), proactive: z.boolean().default(false) })
    .default({ voice: false, proactive: false }),
});

export const ScenarioService = z.object({
  name: z.string().min(1),
  surfaces: z.array(Surface).min(1),
  baselineErrorRate: z.number().min(0).max(1).default(0.004),
  faultyErrorRate: z.number().min(0).max(1).default(0.034),
});

export const ScenarioDeployment = z.object({
  service: z.string().min(1),
  version: z.string().min(1),
  sha: z.string().min(7),
  author: z.string().min(1),
  at: Offset,
  message: z.string().default(""),
  faulty: z.boolean().default(false),
  environment: z.string().default("production"),
});

export const ScenarioProvider = z.object({
  name: z.string().min(1),
  status: z.enum(["operational", "degraded", "outage"]),
  components: z.array(z.object({ name: z.string(), status: z.string() })).default([]),
  detail: z.string().default(""),
});

export const ScenarioAttempt = z.object({
  customerRef: z.string().min(1),
  at: Offset,
  method: PaymentMethod,
  status: z.enum(["success", "failed", "pending"]),
  amountInr: z.number().positive(),
});

export const ScenarioTicket = z.object({
  at: Offset,
  customerRef: z.string().min(1),
  channel: Channel,
  subject: z.string().optional(),
  body: z.string().min(1),
});

export const ScenarioExpected = z.object({
  incident: z.boolean(),
  rootCause: z.string().optional(),
  linkedTickets: z.number().int().optional(),
  affected: z.number().int().optional(),
  silent: z.number().int().optional(),
  voiceUpdates: z.number().int().optional(),
  /** Customers whose credit needs a human decision. */
  needsHuman: z.number().int().optional(),
  /** Credits the agents issue on their own, in total. */
  autoCreditInr: z.number().optional(),
  refusedBy: z.enum(["size", "cohesion", "failure_share", "burst"]).optional(),
});

export const ScenarioSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/),
    title: z.string().min(1),
    purpose: z.string().min(1),
    expected: ScenarioExpected,
    speed: z.number().positive().default(1),
    world: z.object({
      services: z.array(ScenarioService),
      deployments: z.array(ScenarioDeployment),
      providers: z.array(ScenarioProvider),
      customers: z.array(ScenarioCustomer),
      attempts: z.array(ScenarioAttempt),
      baselinePerHour: z.partialRecord(Surface, z.number().positive()).default({}),
    }),
    tickets: z.array(ScenarioTicket).min(1),
  })
  .superRefine((scenario, ctx) => {
    const known = new Set(scenario.world.customers.map((c) => c.ref));
    scenario.tickets.forEach((t, i) => {
      if (!known.has(t.customerRef)) {
        ctx.addIssue({ code: "custom", path: ["tickets", i, "customerRef"], message: `Unknown customer "${t.customerRef}"` });
      }
    });
    scenario.world.attempts.forEach((a, i) => {
      if (!known.has(a.customerRef)) {
        ctx.addIssue({ code: "custom", path: ["world", "attempts", i, "customerRef"], message: `Unknown customer "${a.customerRef}"` });
      }
    });
    const services = new Set(scenario.world.services.map((s) => s.name));
    scenario.world.deployments.forEach((d, i) => {
      if (!services.has(d.service)) {
        ctx.addIssue({ code: "custom", path: ["world", "deployments", i, "service"], message: `Unknown service "${d.service}"` });
      }
    });
  });

export type Scenario = z.infer<typeof ScenarioSchema>;
export type ScenarioWorld = Scenario["world"];
export type ScenarioCustomer = z.infer<typeof ScenarioCustomer>;
export type ScenarioDeployment = z.infer<typeof ScenarioDeployment>;
export type ScenarioProvider = z.infer<typeof ScenarioProvider>;
export type ScenarioAttempt = z.infer<typeof ScenarioAttempt>;
export type ScenarioService = z.infer<typeof ScenarioService>;
