import type { CorrelationConfig, GateResult } from "@crisiscrew/contracts";
import { poissonTail } from "../math/poisson";

export type ClusterStats = {
  size: number;
  cohesion: number;
  failureCount: number;
  /** Seconds between the first and last failure report. */
  spanSec: number;
  baselinePerHour: number;
};

const UNITS: [number, string][] = [
  [1e12, "trillion"],
  [1e9, "billion"],
  [1e6, "million"],
  [1e3, "thousand"],
];

/** Plain-language odds: 2.5e-9 becomes "1 in 400 million". */
export function humanOdds(p: number): string {
  if (p <= 0) return "less than 1 in a trillion";
  const odds = 1 / p;
  for (const [size, word] of UNITS) {
    if (odds >= size) return `1 in ${Number((odds / size).toPrecision(2))} ${word}`;
  }
  return `1 in ${Math.max(1, Math.round(odds))}`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function describeSpan(sec: number): string {
  if (sec < 90) return plural(Math.max(1, Math.round(sec)), "second");
  return plural(Math.round(sec / 60), "minute");
}

export type GateEvaluation = { gates: GateResult[]; fires: boolean; burstP: number; baselinePerHour: number };

/**
 * The four incident gates from design section 5.3. A cluster opens an
 * incident only when every gate passes.
 */
export function evaluateGates(stats: ClusterStats, cfg: CorrelationConfig): GateEvaluation {
  const baselinePerHour = Math.max(cfg.baselineFloorPerHour, stats.baselinePerHour);
  const minutes = Math.max(stats.spanSec / 60, 1);
  const burstP = stats.failureCount === 0 ? 1 : poissonTail(stats.failureCount, (baselinePerHour / 60) * minutes);
  const failureShare = stats.size === 0 ? 0 : stats.failureCount / stats.size;
  const questions = stats.size - stats.failureCount;
  const cohesion = Number(stats.cohesion.toFixed(2));

  const gates: GateResult[] = [
    {
      name: "size",
      value: stats.size,
      threshold: cfg.sizeMin,
      pass: stats.size >= cfg.sizeMin,
      reason:
        stats.size >= cfg.sizeMin
          ? `${plural(stats.size, "ticket")} in this group`
          : `only ${plural(stats.size, "ticket")} in this group (needs ${cfg.sizeMin})`,
    },
    {
      name: "cohesion",
      value: stats.cohesion,
      threshold: cfg.cohesionMin,
      pass: stats.cohesion >= cfg.cohesionMin,
      reason:
        stats.cohesion >= cfg.cohesionMin
          ? `they describe the same thing (similarity ${cohesion}, needs ${cfg.cohesionMin})`
          : `these complaints are about different things (similarity ${cohesion}, needs ${cfg.cohesionMin})`,
    },
    {
      name: "failure_share",
      value: failureShare,
      threshold: cfg.failureShareMin,
      pass: failureShare >= cfg.failureShareMin,
      reason:
        failureShare >= cfg.failureShareMin
          ? `${stats.failureCount} of ${stats.size} report something broken`
          : `${questions} of ${stats.size} are questions, not failures`,
    },
    {
      name: "burst",
      value: burstP,
      threshold: cfg.burstPMax,
      pass: burstP <= cfg.burstPMax,
      reason:
        stats.failureCount === 0
          ? "no failure reports in this group"
          : burstP <= cfg.burstPMax
            ? `${plural(stats.failureCount, "failure")} in ${describeSpan(stats.spanSec)}: about ${humanOdds(burstP)} at normal volume (${baselinePerHour}/hour)`
            : `${plural(stats.failureCount, "failure")} in ${describeSpan(stats.spanSec)} is within normal volume (${baselinePerHour}/hour)`,
    },
  ];

  return { gates, fires: gates.every((g) => g.pass), burstP, baselinePerHour };
}
