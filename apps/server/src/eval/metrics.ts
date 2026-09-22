/** What happened in one eval run, compared with its label. */
export type Outcome = {
  kind: string;
  expectedIncident: boolean;
  fired: boolean;
  /** Tickets in the opened incident (initial plus joined) that are labeled as the incident. */
  linkedLabeled: number;
  /** All tickets in the opened incident. */
  linkedTotal: number;
  /** Tickets labeled as the incident in this run. */
  labeledTotal: number;
  /** Labeled tickets received up to and including the one that opened the incident. */
  latencyTickets?: number;
  /** Seconds from the first labeled ticket to the incident opening. */
  latencySec?: number;
  rootCorrect?: boolean;
  /** Incidents opened in the run besides the one scored above; each is a false alarm. */
  extraIncidents?: number;
};

export type Score = {
  runs: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  linkPrecision: number | null;
  linkRecall: number | null;
  medianLatencyTickets: number | null;
  medianLatencySec: number | null;
  rootAccuracy: number | null;
};

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** A run counts as caught when an incident opened and covered at least half of the labeled tickets. */
function caught(o: Outcome): boolean {
  return o.expectedIncident && o.fired && o.labeledTotal > 0 && o.linkedLabeled / o.labeledTotal >= 0.5;
}

/**
 * Incident-level precision and recall. An incident opened on the wrong tickets
 * counts as both a false alarm and a miss.
 */
export function score(outcomes: Outcome[]): Score {
  const hits = outcomes.filter(caught);
  const tp = hits.length;
  const fn = outcomes.filter((o) => o.expectedIncident && !caught(o)).length;
  const fp = outcomes.filter((o) => o.fired && !caught(o)).length + outcomes.reduce((n, o) => n + (o.extraIncidents ?? 0), 0);
  const tn = outcomes.filter((o) => !o.expectedIncident && !o.fired).length;
  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  const recall = tp + fn > 0 ? tp / (tp + fn) : null;
  const f1 = precision === null || recall === null ? null : precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const roots = hits.filter((h) => h.rootCorrect !== undefined);
  return {
    runs: outcomes.length,
    tp,
    fp,
    fn,
    tn,
    precision,
    recall,
    f1,
    linkPrecision: mean(hits.map((h) => h.linkedLabeled / h.linkedTotal)),
    linkRecall: mean(hits.map((h) => h.linkedLabeled / h.labeledTotal)),
    medianLatencyTickets: median(hits.flatMap((h) => (h.latencyTickets === undefined ? [] : [h.latencyTickets]))),
    medianLatencySec: median(hits.flatMap((h) => (h.latencySec === undefined ? [] : [h.latencySec]))),
    rootAccuracy: roots.length ? roots.filter((r) => r.rootCorrect).length / roots.length : null,
  };
}
