import type { EvidenceItem, Hypothesis, RcaConfig } from "@crisiscrew/contracts";
import type { Deployment, ErrorRatePoint, ProviderHealth } from "../ports";

const MIN = 60_000;

export type RcaInput = {
  firstComplaintAt: number;
  /** Releases of the services behind the incident's product area; null when the check failed. */
  deployments: Deployment[] | null;
  /** Error-rate series per service; null when the check failed. */
  errorSeries: Record<string, ErrorRatePoint[]> | null;
  /** Payment provider status; null when the check failed. */
  providers: ProviderHealth[] | null;
  /** Payment methods named in each complaint. */
  paymentMethods: string[][];
  adapters: { deployments: string; metrics: string; payments: string };
};

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

function describeGap(ms: number): string {
  const minutes = Math.round(Math.abs(ms) / MIN);
  const text = minutes < 120 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
  return ms >= 0 ? `released ${text} before the first complaint` : `released ${text} after the first complaint`;
}

function timingEvidence(d: Deployment, firstAt: number, cfg: RcaConfig, adapter: string): EvidenceItem {
  const gap = firstAt - d.at;
  const g = cfg.deployGap;
  const lr = gap < 0 ? g.afterLr : gap <= g.withinMin * MIN ? g.withinLr : gap <= g.nearMin * MIN ? g.nearLr : g.farLr;
  return { source: "get_recent_deployments", observation: `${describeGap(gap)} (${d.sha.slice(0, 7)} by ${d.author}: "${d.message}")`, lr, adapter, checked: true };
}

function errorEvidence(d: Deployment, series: ErrorRatePoint[] | undefined | null, cfg: RcaConfig, adapter: string): EvidenceItem {
  const source = "get_service_status";
  if (series === null) return { source, observation: "error rates not checked", lr: 1, adapter, checked: false };
  const before = (series ?? []).filter((p) => p.at >= d.at - 60 * MIN && p.at < d.at).map((p) => p.rate);
  const after = (series ?? []).filter((p) => p.at >= d.at).map((p) => p.rate);
  if (before.length === 0 || after.length === 0) {
    return { source, observation: `not enough error-rate data around ${d.service} v${d.version}`, lr: 1, adapter, checked: false };
  }
  const b = Math.max(mean(before), 1e-6);
  const a = mean(after);
  const ratio = a / b;
  const r = cfg.errorRatio;
  const lr = ratio >= r.strongMin ? Math.min(ratio, r.cap) : ratio >= r.weakMin ? r.weakLr : r.noneLr;
  return {
    source,
    observation: `${d.service} error rate ${pct(b)} → ${pct(a)} after the release (${ratio.toFixed(1)}×)`,
    lr,
    adapter,
    checked: true,
  };
}

function methodEvidence(paymentMethods: string[][], cfg: RcaConfig): EvidenceItem | null {
  const naming = paymentMethods.filter((m) => m.length > 0);
  if (naming.length === 0) return null;
  const counts = new Map<string, number>();
  for (const methods of naming) for (const m of new Set(methods)) counts.set(m, (counts.get(m) ?? 0) + 1);
  const [top, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
  const share = topCount / naming.length;
  const s = cfg.methodSpread;
  const concentrated = share >= s.concentratedShare;
  const observation = concentrated
    ? `${topCount} of ${naming.length} complaints that name a payment method name ${top.toUpperCase()}: points to one provider`
    : `complaints name ${[...counts.entries()].map(([m, c]) => `${m.toUpperCase()} (${c})`).join(", ")}: failures span methods, so less likely one provider`;
  return { source: "complaints", observation, lr: concentrated ? s.concentratedLr : s.spreadLr, adapter: "core", checked: true };
}

/**
 * Ranks root-cause hypotheses (design section 7): prior x the likelihood
 * ratio of each piece of evidence, normalised so confidences sum to 1. The
 * priors and ratios come from policy and are uncalibrated defaults.
 */
export function scoreHypotheses(input: RcaInput, cfg: RcaConfig): Hypothesis[] {
  const drafts: Omit<Hypothesis, "score" | "confidence">[] = [];

  if (input.deployments === null) {
    drafts.push({
      id: "deploy:unverified",
      kind: "deploy",
      subject: "unverified",
      label: "A recent release (deployments not checked)",
      prior: cfg.priors.deploy,
      evidence: [{ source: "get_recent_deployments", observation: "deployments not checked", lr: 1, adapter: input.adapters.deployments, checked: false }],
    });
  } else {
    for (const d of input.deployments) {
      drafts.push({
        id: `deploy:${d.service}@${d.version}`,
        kind: "deploy",
        subject: `${d.service}@${d.version}`,
        label: `${d.service} v${d.version}`,
        prior: cfg.priors.deploy / input.deployments.length,
        evidence: [
          timingEvidence(d, input.firstComplaintAt, cfg, input.adapters.deployments),
          errorEvidence(d, input.errorSeries === null ? null : input.errorSeries[d.service], cfg, input.adapters.metrics),
        ],
      });
    }
  }

  const methods = methodEvidence(input.paymentMethods, cfg);
  if (input.providers === null) {
    drafts.push({
      id: "provider:unverified",
      kind: "provider",
      subject: "unverified",
      label: "The payment gateway (status not checked)",
      prior: cfg.priors.provider,
      evidence: [
        { source: "get_payment_health", observation: "gateway status not checked", lr: 1, adapter: input.adapters.payments, checked: false },
        ...(methods ? [methods] : []),
      ],
    });
  } else {
    for (const p of input.providers) {
      const healthy = p.status === "operational";
      const parts = p.components.map((c) => `${c.name} ${c.status}`).join(", ");
      drafts.push({
        id: `provider:${p.provider}`,
        kind: "provider",
        subject: p.provider,
        label: `${p.provider[0]!.toUpperCase()}${p.provider.slice(1)} payment gateway`,
        prior: cfg.priors.provider / input.providers.length,
        evidence: [
          {
            source: "get_payment_health",
            observation: `${p.provider} reports ${p.status}${parts ? ` (${parts})` : ""}${p.detail ? `: ${p.detail}` : ""}`,
            lr: healthy ? cfg.provider.operationalLr : cfg.provider.degradedLr,
            adapter: input.adapters.payments,
            checked: true,
          },
          ...(methods ? [methods] : []),
        ],
      });
    }
  }

  drafts.push({ id: "unknown", kind: "unknown", subject: "unknown", label: "Something not yet identified", prior: cfg.priors.unknown, evidence: [] });

  const scored = drafts.map((h) => ({ ...h, score: h.evidence.reduce((s, e) => s * e.lr, h.prior) }));
  const total = scored.reduce((s, h) => s + h.score, 0);
  return scored.map((h) => ({ ...h, confidence: h.score / total })).sort((a, b) => b.confidence - a.confidence);
}
