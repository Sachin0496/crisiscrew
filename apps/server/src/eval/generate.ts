import { ScenarioSchema, type Channel, type Scenario } from "@crisiscrew/contracts";
import { mulberry32 } from "@crisiscrew/core";
import type { Pools } from "../corpus";

export const RUN_KINDS = ["checkout_release", "upi_outage", "login_otp", "quiet", "lookalike", "scattered"] as const;
export type RunKind = (typeof RUN_KINDS)[number] | "stress_delivery_mix";

export type EvalRun = {
  id: string;
  seed: number;
  split: "tune" | "test";
  kind: RunKind;
  scenario: Scenario;
  /** Indices into scenario.tickets (time order) of the tickets that make up the incident. */
  labeled: number[];
};

const SCATTERED = ["scattered-delivery", "scattered-refunds", "scattered-app", "scattered-account", "scattered-orders"];
const CHANNELS: Channel[] = ["chat", "email", "portal", "phone"];
const HOUR_SEC = 3600;

type Rng = () => number;
type Draft = { atSec: number; body: string; labeled: boolean };

function pool(pools: Pools, name: string, split: "tune" | "test" | "all"): string[] {
  const texts = pools[name];
  if (!texts) throw new Error(`missing pool ${name}`);
  if (split === "all") return texts;
  // Tune runs draw from even positions, test runs from odd ones, so no sentence is shared.
  return texts.filter((_, i) => i % 2 === (split === "tune" ? 0 : 1));
}

function sample<T>(rng: Rng, items: T[], n: number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy.slice(0, Math.min(n, copy.length));
}

const between = (rng: Rng, lo: number, hi: number) => lo + (hi - lo) * rng();
const offset = (sec: number) => `${sec < 0 ? "-" : "+"}${Math.abs(Math.round(sec))}s`;

/** Texts spread over [start, start + spread] seconds, the first exactly at start. */
function burst(rng: Rng, texts: string[], start: number, spread: number, labeled: boolean): Draft[] {
  const times = texts.map((_, i) => (i === 0 ? 0 : between(rng, 0, spread))).sort((a, b) => a - b);
  return texts.map((body, i) => ({ atSec: start + times[i]!, body, labeled }));
}

function build(seed: number, split: "tune" | "test", kind: RunKind, rng: Rng, pools: Pools): EvalRun {
  const drafts: Draft[] = sample(rng, pool(pools, "background", split), 12).map((body) => ({ atSec: between(rng, 0, HOUR_SEC), body, labeled: false }));
  const start = between(rng, 1200, 2400);
  const deployments: Scenario["world"]["deployments"] = [
    { service: "checkout-service", version: "4.20.0", sha: "a1b2c3d4e5f6", author: "release-bot", at: offset(-30 * HOUR_SEC), message: "Routine release", faulty: false, environment: "production" },
    { service: "auth-service", version: "2.7.0", sha: "0f1e2d3c4b5a", author: "release-bot", at: offset(-30 * HOUR_SEC), message: "Routine release", faulty: false, environment: "production" },
  ];
  let provider: "operational" | "degraded" = "operational";
  let rootCause: string | undefined;

  if (kind === "checkout_release" || kind === "upi_outage" || kind === "login_otp") {
    const texts = sample(rng, pool(pools, `incident-${kind.replace("_", "-")}`, split), 4 + Math.floor(rng() * 4));
    drafts.push(...burst(rng, texts, start, between(rng, 60, 180), true));
    const shippedAt = start - between(rng, 300, 1500);
    if (kind === "checkout_release") {
      const version = `4.21.${seed}`;
      deployments.push({ service: "checkout-service", version, sha: `c0ffee${String(seed).padStart(6, "0")}`, author: "dev", at: offset(shippedAt), message: "Checkout change", faulty: true, environment: "production" });
      rootCause = `deploy:checkout-service@${version}`;
    } else if (kind === "login_otp") {
      const version = `2.8.${seed}`;
      deployments.push({ service: "auth-service", version, sha: `0a0b0c${String(seed).padStart(6, "0")}`, author: "dev", at: offset(shippedAt), message: "Auth change", faulty: true, environment: "production" });
      rootCause = `deploy:auth-service@${version}`;
    } else {
      provider = "degraded";
      rootCause = "provider:razorpay";
    }
  } else if (kind === "lookalike") {
    drafts.push(...burst(rng, sample(rng, pool(pools, "lookalike-questions", split), 5 + Math.floor(rng() * 2)), start, 480, false));
  } else if (kind === "scattered") {
    const texts = SCATTERED.map((name) => sample(rng, pool(pools, name, split), 1)[0]!);
    drafts.push(...burst(rng, sample(rng, texts, texts.length), start, 600, false));
  } else if (kind === "quiet") {
    for (const name of sample(rng, SCATTERED, 2)) {
      drafts.push({ atSec: between(rng, 0, HOUR_SEC), body: sample(rng, pool(pools, name, split), 1)[0]!, labeled: false });
    }
  } else {
    // Nothing is tuned on the stress test, so it draws from the whole pool rather than one half.
    drafts.push(...burst(rng, sample(rng, pool(pools, "stress-delivery-mix", "all"), 4 + Math.floor(rng() * 3)), start, 600, false));
  }

  drafts.sort((a, b) => a.atSec - b.atSec);
  const id = `eval-${seed}-${kind.replaceAll("_", "-")}`;
  const scenario = ScenarioSchema.parse({
    id,
    title: `Eval run ${seed}: ${kind}`,
    purpose: "Generated for the evaluation",
    expected: { incident: rootCause !== undefined, ...(rootCause ? { rootCause } : {}) },
    world: {
      services: [
        { name: "checkout-service", surfaces: ["checkout_payments"] },
        { name: "auth-service", surfaces: ["login_account"] },
      ],
      deployments,
      providers: [{ name: "razorpay", status: provider }],
      customers: drafts.map((_, i) => ({ ref: `r${i + 1}`, name: `Customer ${i + 1}` })),
      attempts: [],
    },
    tickets: drafts.map((d, i) => ({ at: offset(d.atSec), customerRef: `r${i + 1}`, channel: CHANNELS[Math.floor(rng() * CHANNELS.length)]!, body: d.body })),
  });
  return { id, seed, split, kind, scenario, labeled: drafts.flatMap((d, i) => (d.labeled ? [i] : [])) };
}

/** Seeded runs: kinds rotate, and whole rounds of kinds alternate between the tune and test splits. */
export function generateRuns(pools: Pools, count: number): EvalRun[] {
  return Array.from({ length: count }, (_, i) => {
    const seed = i + 1;
    const round = Math.floor(i / RUN_KINDS.length);
    return build(seed, round % 2 === 0 ? "tune" : "test", RUN_KINDS[i % RUN_KINDS.length]!, mulberry32(seed * 7919), pools);
  });
}

/** Several different delivery problems in ten minutes: a known hard case, reported on its own. */
export function generateStressRuns(pools: Pools, count: number): EvalRun[] {
  return Array.from({ length: count }, (_, i) => {
    const seed = 1000 + i;
    return build(seed, i % 2 === 0 ? "tune" : "test", "stress_delivery_mix", mulberry32(seed * 7919), pools);
  });
}
