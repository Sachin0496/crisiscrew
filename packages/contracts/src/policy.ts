import { z } from "zod";

const LevelSchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);

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
    recovery: IdentityPolicy,
    handoff: IdentityPolicy,
    operator: IdentityPolicy,
  }),
  limits: z.object({
    authorityLimitInr: z.number().positive(),
    creditPerCustomerInr: z.number().positive(),
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
    priors: z.object({ deploy: z.number().positive(), provider: z.number().positive(), unknown: z.number().positive() }),
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
    methodSpread: z.object({
      concentratedShare: z.number().min(0).max(1),
      concentratedLr: z.number().positive(),
      spreadLr: z.number().positive(),
    }),
  }),
  recovery: z.object({ affectedLookbackMin: z.number().positive() }),
});

export type Policy = z.infer<typeof PolicySchema>;
export type CorrelationConfig = Policy["correlation"];
export type RcaConfig = Policy["rca"];

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
