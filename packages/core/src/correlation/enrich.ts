import type { Entities, Surface } from "@crisiscrew/contracts";
import { cosine, type Vector } from "../math/vector";

export type PrototypeVectors = {
  surfaces: { surface: Exclude<Surface, "other">; vectors: Vector[] }[];
  failure: Vector[];
  question: Vector[];
};

function best(vector: Vector, candidates: Vector[]): number {
  let max = -1;
  for (const c of candidates) max = Math.max(max, cosine(vector, c));
  return max;
}

export type Classification = { surface: Surface; surfaceScore: number; failureScore: number; isFailure: boolean };

/**
 * Surface: the product area whose prototypes are closest, or "other" below
 * `surfaceMin`. Failure score: closeness to failure reports minus closeness
 * to questions; positive means the ticket reports something broken.
 */
export function classify(vector: Vector, prototypes: PrototypeVectors, surfaceMin: number): Classification {
  let surface: Surface = "other";
  let surfaceScore = -1;
  for (const s of prototypes.surfaces) {
    const score = best(vector, s.vectors);
    if (score > surfaceScore) {
      surfaceScore = score;
      surface = s.surface;
    }
  }
  if (surfaceScore < surfaceMin) surface = "other";
  const failureScore = best(vector, prototypes.failure) - best(vector, prototypes.question);
  return { surface, surfaceScore, failureScore, isFailure: failureScore > 0 };
}

const METHOD_PATTERNS: [string, RegExp][] = [
  ["upi", /\b(upi|gpay|google pay|phonepe|phone pe|paytm|bhim)\b/i],
  ["card", /\b(card|credit card|debit card|visa|mastercard|rupay)\b/i],
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
