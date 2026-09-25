import { z } from "zod";
import { Surface } from "./domain";

const LevelSchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);

const ImportanceLevelSchema = z.enum(["P1", "P2", "P3"]);

/** A count or amount that makes an incident P1 at `p1` and P2 at `p2`. */
const Tiered = z
  .object({ p1: z.number().positive(), p2: z.number().positive() })
  .refine((t) => t.p2 <= t.p1, { message: "p2 must not be above p1" });

const IdentityPolicy = z.object({
  name: z.string().min(1),
  maxLevel: LevelSchema,
  tools: z.array(z.string()),
});

export const PolicySchema = z.object({
  identities: z.object({
    pattern: IdentityPolicy,
    commander: IdentityPolicy,
    investigator: IdentityPolicy,
    issue_creator: IdentityPolicy,
    recovery: IdentityPolicy,
    handoff: IdentityPolicy,
    operator: IdentityPolicy,
  }),
  limits: z.object({
    /** The most the agents may pay out in credits for one incident without a human. */
    authorityLimitInr: z.number().positive(),
    /** The largest credit the agents may give one customer without a human. */
    perCustomerLimitInr: z.number().positive(),
  }),
  correlation: z.object({
    windowMin: z.number().positive(),
    edgeThreshold: z.number().min(0).max(1),
    joinThreshold: z.number().min(0).max(1),
    cohesionMin: z.number().min(0).max(1),
    sizeMin: z.number().int().min(2),
    failureShareMin: z.number().min(0).max(1),
    burstPMax: z.number().positive().max(1),
    baselineFloorPerHour: z.number().positive(),
    surfaceMin: z.number().min(0).max(1),
    /** Weight of sentence meaning in the similarity; the rest is product-area agreement. */
    semanticWeight: z.number().min(0).max(1),
    /** Softmax temperature that turns per-surface scores into a product-area profile. */
    surfaceTemperature: z.number().positive(),
    /** Subtracted from the failure score of tickets phrased as questions. */
    questionPenalty: z.number().min(0).max(1),
  }),
  rca: z.object({
    lookbackHours: z.number().positive(),
    confidenceFloor: z.number().min(0).max(1),
    priors: z.object({ deploy: z.number().positive(), provider: z.number().positive(), infra: z.number().positive(), unknown: z.number().positive() }),
    deployGap: z.object({
      withinMin: z.number().positive(),
      withinLr: z.number().positive(),
      nearMin: z.number().positive(),
      nearLr: z.number().positive(),
      farLr: z.number().positive(),
      afterLr: z.number().positive(),
    }),
    errorRatio: z.object({
      strongMin: z.number().positive(),
      cap: z.number().positive(),
      weakMin: z.number().positive(),
      weakLr: z.number().positive(),
      noneLr: z.number().positive(),
    }),
    provider: z.object({ operationalLr: z.number().positive(), degradedLr: z.number().positive(), uncheckedLr: z.number().positive() }),
    /** Infrastructure health from Kubernetes and cloud checks (get_infra_health). */
    infra: z.object({
      /** Pods restarting in a loop. */
      crashLoopLr: z.number().positive(),
      /** Fewer pods ready than wanted. */
      unreadyLr: z.number().positive(),
      /** At least this many restarts across the service's pods, with every pod ready now. */
      restartsMin: z.number().int().min(1),
      restartsLr: z.number().positive(),
      /** Every pod ready, few restarts. */
      healthyLr: z.number().positive(),
      /** A cloud alarm on the service (CloudWatch). */
      alarmLr: z.number().positive(),
      noAlarmLr: z.number().positive(),
      /** CPU at or above this percent is saturation. */
      saturationPercent: z.number().min(1).max(100),
      saturationLr: z.number().positive(),
    }),
    methodSpread: z.object({
      concentratedShare: z.number().min(0).max(1),
      concentratedLr: z.number().positive(),
      spreadLr: z.number().positive(),
    }),
  }),
  importance: z.object({
    /** Product areas whose failure stops customers from paying or signing in: at least P2. */
    tier1Surfaces: z.array(Surface),
    /** Confirmed affected customers. */
    affectedCustomers: Tiered,
    /** The value of the failed or pending payments of confirmed affected customers. */
    failedValueInr: Tiered,
    /** Confirmed affected priority customers. */
    priorityCustomers: Tiered,
    /** A release ranked as the cause at least this confident is at least P2: rolling it back is an option. */
    deployConfidence: z.number().min(0).max(1),
    /** Page the on-call engineer at this level or above. */
    pageAt: ImportanceLevelSchema,
  }),
  issues: z.object({
    /** Request a rollback change when a release is the likely cause at least this confident. */
    rollbackConfidence: z.number().min(0).max(1),
    /** Open a problem record for the post-incident review once the incident is recovered. */
    problemOnRecovered: z.boolean(),
  }),
  alerts: z.object({
    /** A critical alert on a service behind a tier-1 area opens an incident by itself. */
    openOnCritical: z.boolean(),
    /** An alert joins an open incident on the same service's area opened up to this long before it. */
    joinWindowMin: z.number().positive(),
    /** Likelihood ratio for a release when its service alerted after it shipped. */
    criticalLr: z.number().positive(),
    warningLr: z.number().positive(),
  }),
  voice: z.object({
    /** Calls to one customer about one incident, counting the first. */
    maxAttempts: z.number().int().min(1).max(5),
    /** Wait between an unanswered call and the next. */
    retryAfterMin: z.number().nonnegative(),
    /** Customers are called only between these hours, in this time zone. */
    callingHours: z.object({ start: z.number().int().min(0).max(23), end: z.number().int().min(1).max(24), timeZone: z.string().min(1) }),
  }),
  oncall: z.object({
    /** After a page call ends unacknowledged, wait this long (for an acknowledgement another way) before paging the next responder. */
    ackTimeoutMin: z.number().nonnegative(),
    /** How many responders after the first may be paged for one incident. */
    maxEscalations: z.number().int().min(0).max(5),
  }),
  recovery: z.object({
    /** Without a cause's start time, the incident window opens this long before the first complaint. */
    affectedLookbackMin: z.number().positive(),
    /** Goodwill credit by severity: medium, and high (priority customers or a large failed payment). */
    creditInr: z.object({ standard: z.number().nonnegative(), high: z.number().nonnegative() }),
    /** A failed payment at least this large makes the harm high severity. */
    highValueInr: z.number().positive(),
  }),
});

export type Policy = z.infer<typeof PolicySchema>;
export type CorrelationConfig = Policy["correlation"];
export type RcaConfig = Policy["rca"];
export type RecoveryConfig = Policy["recovery"];
export type ImportanceConfig = Policy["importance"];
export type AlertsConfig = Policy["alerts"];

/** Validates policy data and checks that every allow-listed tool exists. */
export function parsePolicy(json: unknown, knownTools: readonly string[]): Policy {
  const policy = PolicySchema.parse(json);
  const known = new Set(knownTools);
  for (const [identity, entry] of Object.entries(policy.identities)) {
    for (const tool of entry.tools) {
      if (!known.has(tool)) throw new Error(`Policy for "${identity}" allows unknown tool "${tool}"`);
    }
  }
  return policy;
}
