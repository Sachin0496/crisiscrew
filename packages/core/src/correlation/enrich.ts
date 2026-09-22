import type { Entities, Surface } from "@crisiscrew/contracts";
import { cosine, type Vector } from "../math/vector";

export type ProductSurface = Exclude<Surface, "other">;

export type PrototypeVectors = {
  surfaces: { surface: ProductSurface; vectors: Vector[] }[];
  failure: Vector[];
  question: Vector[];
};

function best(vector: Vector, candidates: Vector[]): number {
  let max = -1;
  for (const c of candidates) max = Math.max(max, cosine(vector, c));
  return max;
}

const WH_WORD = /^(how|what|where|when|why|which|who)\b/i;
// "Can I…", "Is EMI…", but not "Can't complete payment".
const AUXILIARY = /^(can|could|is|are|do|does|did|will|would|should|may|shall)\s/i;

/** Phrased as a question: a question mark at the end, or an opening "how/what/where…" or "can/is/do…". */
export function questionForm(text: string): boolean {
  const t = text.trim();
  return /\?\s*$/.test(t) || WH_WORD.test(t) || AUXILIARY.test(t);
}

export type Classification = {
  surface: Surface;
  surfaceScore: number;
  surfaceScores: Partial<Record<ProductSurface, number>>;
  failureScore: number;
  isFailure: boolean;
};

/**
 * Surface: the product area whose prototype sentences are closest, or
 * "other" below `surfaceMin`. Failure score: closeness to failure reports
 * minus closeness to questions, minus `questionPenalty` when the ticket is
 * phrased as a question. Positive means the ticket reports something broken.
 */
export function classify(
  vector: Vector,
  text: string,
  prototypes: PrototypeVectors,
  cfg: { surfaceMin: number; questionPenalty: number },
): Classification {
  const surfaceScores: Partial<Record<ProductSurface, number>> = {};
  let surface: Surface = "other";
  let surfaceScore = -1;
  for (const s of prototypes.surfaces) {
    const score = best(vector, s.vectors);
    surfaceScores[s.surface] = score;
    if (score > surfaceScore) {
      surfaceScore = score;
      surface = s.surface;
    }
  }
  if (surfaceScore < cfg.surfaceMin) surface = "other";

  const margin = best(vector, prototypes.failure) - best(vector, prototypes.question);
  const failureScore = margin - (questionForm(text) ? cfg.questionPenalty : 0);
  return { surface, surfaceScore, surfaceScores, failureScore, isFailure: failureScore > 0 };
}

/**
 * Product-area profile: a softmax over per-surface scores. Two tickets about
 * the same area have near-identical profiles whatever their wording. Empty
 * when no surface reaches `floor`, so tickets of unknown area match on
 * meaning alone.
 */
export function surfaceProfile(
  scores: Partial<Record<ProductSurface, number>>,
  temperature: number,
  floor: number,
): Partial<Record<ProductSurface, number>> {
  const entries = Object.entries(scores) as [ProductSurface, number][];
  const max = Math.max(...entries.map(([, s]) => s));
  if (max < floor) return Object.fromEntries(entries.map(([k]) => [k, 0]));
  const weights = entries.map(([k, s]) => [k, Math.exp((s - max) / temperature)] as const);
  const total = weights.reduce((sum, [, w]) => sum + w, 0);
  return Object.fromEntries(weights.map(([k, w]) => [k, w / total]));
}

const METHOD_PATTERNS: [string, RegExp][] = [
  ["upi", /\b(upi|gpay|google pay|phonepe|phone pe|paytm|bhim)\b/i],
  ["card", /\b(cards?|credit cards?|debit cards?|visa|mastercard|rupay)\b/i],
  ["netbanking", /\bnet ?banking\b/i],
  ["wallet", /\bwallet\b/i],
];

/** Payment methods, rupee amounts and order ids, shown as evidence. Not used for correlation. */
export function extractEntities(text: string): Entities {
  const paymentMethods = METHOD_PATTERNS.filter(([, re]) => re.test(text)).map(([m]) => m);
  const amounts = [...text.matchAll(/(?:₹|\brs\.?|\binr)\s?(\d[\d,]*(?:\.\d+)?)/gi)].map((m) => Number(m[1]!.replace(/,/g, "")));
  const orderIds = [...text.matchAll(/#([A-Z0-9][A-Z0-9-]{3,})/g)].map((m) => m[1]!);
  return { paymentMethods, amounts, orderIds };
}
