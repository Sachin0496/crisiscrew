/**
 * The impact evaluation: does the Customer Impact Graph find exactly the
 * customers an incident harmed, including the silent ones, and does every
 * one of them get the recovery the policy sets?
 *
 * Seeded worlds built on the hero scenario's services and faulty release,
 * each with its own customers:
 * - harmed: a failed or pending payment after the release; some complain,
 *   most stay silent, some are priority customers or large payments;
 * - paid on a retry: harmed, but got through (an update, no credit);
 * - distractors that must not count: failures from before the release,
 *   successful payments only, and walk-in complainers with no payment.
 *
 * The engine runs end to end (every agent, the gate, a human approving
 * what's asked), and each run is scored against the world's own truth.
 * Deterministic, offline. Writes docs/eval-impact.md.
 *
 *   pnpm eval:impact
 */
import { CachedEmbedder } from "@crisiscrew/adapters";
import { recoveryCoverage, ScenarioSchema, type Scenario } from "@crisiscrew/contracts";
import { mulberry32 } from "@crisiscrew/core";
import { writeFileSync } from "node:fs";
import { DEFAULT_EMBEDDING_MODEL } from "../config";
import { loadPools } from "../corpus";
import { EMBEDDING_CACHE_DIR, IMPACT_EVAL_DOC } from "../paths";
import { loadPolicy, loadScenarios } from "../scenarios";
import { runEngine } from "./engine-run";

const RUNS = 30;
const embedder = new CachedEmbedder({ modelId: DEFAULT_EMBEDDING_MODEL, dir: EMBEDDING_CACHE_DIR, inner: null });
const policy = loadPolicy();

type Rng = () => number;
const int = (rng: Rng, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
const pick = <T>(rng: Rng, xs: T[]) => xs[Math.floor(rng() * xs.length)]!;
const sec = (s: number) => `${s < 0 ? "-" : "+"}${Math.abs(Math.round(s))}s`;
const METHODS = ["upi", "card", "netbanking", "wallet"] as const;

type Truth = { harmed: Set<string>; complained: Set<string>; retry: Set<string>; walkIns: Set<string>; highValue: Set<string>; priority: Set<string> };

/** One world: who was harmed is decided first, then payments and tickets are drawn to match. */
function world(seed: number, template: Scenario, complaintTexts: string[], questions: string[]): { scenario: Scenario; truth: Truth } {
  const rng = mulberry32(seed * 104_729);
  const release = -795;
  const harmedCount = int(rng, 8, 36);
  const complainCount = int(rng, 4, Math.min(8, harmedCount));
  const retryCount = int(rng, 0, 3);
  const preWindow = int(rng, 2, 8);
  const successOnly = int(rng, 4, 14);
  const walkIns = int(rng, 0, 2);
  const truth: Truth = { harmed: new Set(), complained: new Set(), retry: new Set(), walkIns: new Set(), highValue: new Set(), priority: new Set() };
  const customers: Record<string, unknown>[] = [];
  const attempts: Record<string, unknown>[] = [];
  const tickets: Record<string, unknown>[] = [];
  const add = (ref: string, over: Record<string, unknown> = {}) =>
    customers.push({ ref, name: `Customer ${ref.toUpperCase()}`, email: `${ref}@example.com`, consent: { proactive: rng() < 0.8, voice: rng() < 0.3 }, ...over });

  for (let i = 0; i < harmedCount; i++) {
    const ref = `h${i + 1}`;
    const priority = rng() < 0.12;
    add(ref, { tier: priority ? "priority" : "standard" });
    truth.harmed.add(ref);
    if (priority) truth.priority.add(ref);
    const amount = rng() < 0.1 ? int(rng, 10_000, 30_000) : int(rng, 199, 9_999);
    if (amount >= policy.recovery.highValueInr) truth.highValue.add(ref);
    const at = int(rng, release + 30, -20);
    attempts.push({ customerRef: ref, at: sec(at), method: pick(rng, [...METHODS]), status: rng() < 0.85 ? "failed" : "pending", amountInr: amount });
  }
  // Retry customers: a failure after the release, then a success.
  for (let i = 0; i < retryCount; i++) {
    const ref = `r${i + 1}`;
    add(ref);
    truth.harmed.add(ref);
    truth.retry.add(ref);
    const at = int(rng, release + 30, -120);
    attempts.push({ customerRef: ref, at: sec(at), method: "upi", status: "failed", amountInr: 499 });
    attempts.push({ customerRef: ref, at: sec(at + 60), method: "upi", status: "success", amountInr: 499 });
  }
  // Distractors: a failure long before the release, or only successful payments.
  for (let i = 0; i < preWindow; i++) {
    const ref = `p${i + 1}`;
    add(ref);
    attempts.push({ customerRef: ref, at: sec(-int(rng, 2_400, 3_600)), method: pick(rng, [...METHODS]), status: "failed", amountInr: int(rng, 199, 4_999) });
  }
  for (let i = 0; i < successOnly; i++) {
    const ref = `o${i + 1}`;
    add(ref);
    attempts.push({ customerRef: ref, at: sec(int(rng, release, -10)), method: pick(rng, [...METHODS]), status: "success", amountInr: int(rng, 199, 4_999) });
  }
  // The complaints: a burst from harmed customers, plus walk-ins with no payment on record.
  const complainers = [...truth.harmed].filter((r) => !truth.retry.has(r)).slice(0, complainCount);
  const texts = [...complaintTexts].sort(() => rng() - 0.5);
  complainers.forEach((ref, i) => {
    truth.complained.add(ref);
    tickets.push({ at: sec(i * int(rng, 8, 20)), customerRef: ref, channel: "chat", body: texts[i % texts.length] });
  });
  for (let i = 0; i < walkIns; i++) {
    const ref = `w${i + 1}`;
    add(ref);
    truth.walkIns.add(ref);
    tickets.push({ at: sec(complainCount * 20 + i * 15), customerRef: ref, channel: "email", body: texts[(complainCount + i) % texts.length] });
  }
  // Ordinary questions around the burst.
  for (let i = 0; i < 3; i++) {
    const ref = `q${i + 1}`;
    add(ref);
    tickets.push({ at: sec(int(rng, -600, 300)), customerRef: ref, channel: "portal", body: pick(rng, questions) });
  }
  const scenario = ScenarioSchema.parse({
    ...template,
    id: `impact-${seed}`,
    title: `Impact run ${seed}`,
    purpose: "Generated for the impact evaluation",
    expected: { incident: true },
    world: { ...template.world, customers, attempts },
    tickets,
  });
  return { scenario, truth };
}

const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);

async function main() {
  const template = loadScenarios().get("checkout-v4.21.7")!;
  const pools = loadPools();
  const complaintTexts = pools["incident-checkout-release"] ?? [];
  const questions = (pools.background ?? []).filter((q) => !/checkout|pay|upi|card/i.test(q));

  const totals = { runs: 0, opened: 0, harmed: 0, found: 0, confirmed: 0, silentTruth: 0, silentFound: 0, walkIns: 0, walkInsHeld: 0, walkInsPaid: 0, distractorsCounted: 0 };
  const credits = { expected: 0, right: 0, wrong: 0, toHuman: 0, humanExpected: 0 };
  let covered = 0;
  const perRun: { seed: number; harmed: number; complained: number; silent: number; found: number; precision: number; coverage: string }[] = [];

  for (let seed = 1; seed <= RUNS; seed++) {
    const { scenario, truth } = world(seed, template, complaintTexts, questions);
    const { state } = await runEngine(scenario, { policy, embedder, approveAll: true });
    totals.runs++;
    const incident = state.incidentOrder.map((id) => state.incidents[id]!)[0];
    if (!incident?.impact) continue;
    totals.opened++;
    const confirmed = incident.impact.customers.filter((c) => c.confidence === "confirmed");
    const confirmedRefs = new Set(confirmed.map((c) => c.ref));
    const found = [...truth.harmed].filter((r) => confirmedRefs.has(r)).length;
    const silentTruth = [...truth.harmed].filter((r) => !truth.complained.has(r));
    const silentFound = silentTruth.filter((r) => confirmed.find((c) => c.ref === r && !c.complained)).length;
    totals.harmed += truth.harmed.size;
    totals.found += found;
    totals.confirmed += confirmed.length;
    totals.silentTruth += silentTruth.length;
    totals.silentFound += silentFound;
    totals.distractorsCounted += confirmed.filter((c) => !truth.harmed.has(c.ref)).length;
    for (const w of truth.walkIns) {
      const entry = incident.impact.customers.find((c) => c.ref === w);
      if (!entry) continue;
      totals.walkIns++;
      if (entry.confidence === "unverified") totals.walkInsHeld++;
      if (state.credits.some((c) => c.customerRef === w)) totals.walkInsPaid++;
    }
    // The credit each harmed customer should end with: none after a retry, ₹1,000 (via a human) for priority or large payments, else ₹200.
    for (const ref of truth.harmed) {
      const expected = truth.retry.has(ref) ? 0 : truth.priority.has(ref) || truth.highValue.has(ref) ? policy.recovery.creditInr.high : policy.recovery.creditInr.standard;
      const paid = state.credits.filter((c) => c.customerRef === ref).reduce((s, c) => s + c.amountInr, 0);
      credits.expected++;
      if (paid === expected) credits.right++;
      else credits.wrong++;
      if (expected > policy.limits.perCustomerLimitInr) {
        credits.humanExpected++;
        if (Object.values(state.approvals).some((a) => a.customerRef === ref)) credits.toHuman++;
      }
    }
    const coverage = recoveryCoverage(incident);
    if (coverage.complete) covered++;
    perRun.push({
      seed,
      harmed: truth.harmed.size,
      complained: truth.complained.size,
      silent: silentTruth.length,
      found,
      precision: confirmed.length ? found / confirmed.length : 1,
      coverage: `${coverage.recovered}/${coverage.confirmed}`,
    });
  }

  const precision = totals.confirmed ? totals.found / totals.confirmed : null;
  const recall = totals.harmed ? totals.found / totals.harmed : null;
  const silentRecall = totals.silentTruth ? totals.silentFound / totals.silentTruth : null;
  const date = new Date().toISOString().slice(0, 10);
  const doc = `# Impact evaluation

Generated by \`pnpm eval:impact\` on ${date}. ${RUNS} seeded worlds, each with its own customers and payments around the hero scenario's faulty checkout release. The engine runs end to end: every agent, the policy gate, and a human who approves each credit as asked. Deterministic and offline.

## What each world contains

- **Harmed customers (8 to 36):** a failed or pending payment after the release. 4 to 8 of them complain in a burst; the rest stay silent. About 1 in 8 is a priority customer, and about 1 in 10 failed on a payment of ₹10,000 or more.
- **Paid on a retry (0 to 3):** a failure after the release, then a successful retry. They're harmed, but they got through.
- **Distractors that must not count:**
  - customers whose payment failed 40 to 60 minutes before the release (2 to 8);
  - customers with only successful payments (4 to 14);
  - walk-ins who complain in the same words but have no payment on record (0 to 2);
  - ordinary questions from other customers.

## Results

| Measure | Result |
|---|---|
| Incidents opened | ${totals.opened} of ${totals.runs} worlds |
| **Affected-customer precision** | ${pct(precision)} (${totals.found} of ${totals.confirmed} confirmed customers were truly harmed) |
| **Affected-customer recall** | ${pct(recall)} (${totals.found} of ${totals.harmed} harmed customers found) |
| **Silent-customer recall** | ${pct(silentRecall)} (${totals.silentFound} of ${totals.silentTruth} customers who never complained were found) |
| Distractors counted as harmed | ${totals.distractorsCounted} |
| Walk-ins held as *not verified* | ${totals.walkInsHeld} of ${totals.walkIns}; paid: ${totals.walkInsPaid} |
| Right credit for each harmed customer | ${credits.right} of ${credits.expected} (none after a retry, ₹${policy.recovery.creditInr.standard} for a failed payment, ₹${policy.recovery.creditInr.high} through a human for priority customers or ₹${policy.recovery.highValueInr.toLocaleString("en-IN")}+ payments) |
| Credits above authority that went to a human | ${credits.toHuman} of ${credits.humanExpected} |
| Worlds that reached 100% Recovery Coverage | ${covered} of ${totals.opened} |

## Per world

| World | Harmed | Complained | Silent | Found | Precision | Coverage |
|---|---|---|---|---|---|---|
${perRun.map((r) => `| ${r.seed} | ${r.harmed} | ${r.complained} | ${r.silent} | ${r.found} | ${pct(r.precision)} | ${r.coverage} |`).join("\n")}

## Limits

- **The truth is the world's own payment data:** "harmed" means a failed or pending payment after the release, which is how CrisisCrew defines it. The evaluation shows the Impact Graph applies that definition exactly, silent customers included. It can't show the definition is right for every business: a harm without a failed payment (a slow page that made someone give up) isn't in the data.
- **Synthetic worlds:** generated, not production traffic. The complaint wording comes from the hand-written paraphrase pool.
- **One incident shape:** a faulty release on checkout. A provider outage or a login failure has its own evidence, and would need its own worlds.
`;
  writeFileSync(IMPACT_EVAL_DOC, doc);
  console.log(`opened ${totals.opened}/${totals.runs}; precision ${pct(precision)} recall ${pct(recall)} silent recall ${pct(silentRecall)}; distractors ${totals.distractorsCounted}; walk-ins held ${totals.walkInsHeld}/${totals.walkIns} paid ${totals.walkInsPaid}; credits right ${credits.right}/${credits.expected}; to human ${credits.toHuman}/${credits.humanExpected}; covered ${covered}/${totals.opened}`);
  console.log(`wrote ${IMPACT_EVAL_DOC.pathname}`);
}

await main();
