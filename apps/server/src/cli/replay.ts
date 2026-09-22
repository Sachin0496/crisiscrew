/**
 * Replays a scenario in the terminal and prints what each agent does.
 *
 *   pnpm replay checkout-v4.21.7
 *   pnpm replay checkout-v4.21.7 --speed 20 --decide modify:5000
 *   pnpm replay lookalike-checkout-questions
 */
import { CachedEmbedder, LocalEmbedder } from "@crisiscrew/adapters";
import { SURFACE_LABELS, type CrisisEvent, type DecisionBody } from "@crisiscrew/contracts";
import { humanOdds, inr } from "@crisiscrew/core";
import { DEFAULT_EMBEDDING_MODEL } from "../config";
import { EMBEDDING_CACHE_DIR, MODELS_DIR } from "../paths";
import { Runtime } from "../runtime";
import { loadPolicy, loadScenarios } from "../scenarios";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const scenarios = loadScenarios();
const id = args.find((a) => !a.startsWith("--") && scenarios.has(a));
if (!id) {
  console.log(`Usage: pnpm replay <scenario> [--speed N] [--decide approve|reject|modify:<amount>]\n\nScenarios:\n${[...scenarios.values()].map((s) => `  ${s.id.padEnd(30)} ${s.title}`).join("\n")}`);
  process.exit(1);
}
const speed = Number(flag("speed") ?? 20);
const decideArg = flag("decide");

const model = process.env.EMBEDDINGS_MODEL || DEFAULT_EMBEDDING_MODEL;
const runtime = new Runtime({
  policy: loadPolicy(),
  scenarios,
  embedder: new CachedEmbedder({
    modelId: model,
    dir: EMBEDDING_CACHE_DIR,
    inner: new LocalEmbedder(model, { cacheDir: process.env.EMBEDDINGS_MODEL_DIR || MODELS_DIR, threads: 2, offline: false }),
  }),
  latencyMs: 150,
  liveWorld: id,
  onError: (e) => console.error("error:", e),
});

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

let t0 = 0;
const clock = (at: number) => {
  const s = Math.round((at - t0) / 1000);
  return `${s < 0 ? "-" : "+"}${Math.floor(Math.abs(s) / 60)}:${String(Math.abs(s) % 60).padStart(2, "0")}`;
};
/** Incidents already announced: a later cluster update for one of them is a ticket joining it. */
const announced = new Set<string>();

function print(e: CrisisEvent): void {
  switch (e.type) {
    case "session.started":
      t0 = e.at;
      console.log(bold(`\n${e.payload.scenarioTitle}  (replay at ${e.payload.speed}× speed)\n`));
      break;
    case "ticket.received":
      console.log(`${dim(clock(e.at))}  ${e.payload.ticket.id}  ${e.payload.ticket.channel.padEnd(6)} ${e.payload.ticket.customerName.padEnd(16)} "${e.payload.ticket.body}"`);
      break;
    case "signal.scored": {
      const s = e.payload.signal;
      console.log(dim(`         ${SURFACE_LABELS[s.surface]} · ${s.isFailure ? "reports a failure" : "a question or request"} (${s.failureScore.toFixed(2)})`));
      break;
    }
    case "cluster.updated": {
      const c = e.payload.cluster;
      if (c.memberTicketIds.length < 2) break;
      const gates = c.gates.map((g) => `${g.name} ${g.pass ? green("✓") : red("✗")}`).join("  ");
      console.log(
        dim(`         cluster of ${c.memberTicketIds.length}: similarity ${c.cohesion.toFixed(2)} (meaning ${c.cohesionParts.meaning.toFixed(2)}, area ${c.cohesionParts.area.toFixed(2)})  `) +
          gates,
      );
      if (c.incidentId && announced.has(c.incidentId)) {
        console.log(green(`         joins ${c.incidentId}, which now has ${c.memberTicketIds.length} tickets`));
      } else if (c.fires) {
        if (c.incidentId) announced.add(c.incidentId);
        console.log(green(`         fires: ${c.failureCount} failures in ${Math.round(c.spanSec)}s is about ${humanOdds(c.burstP)} at normal volume`));
      } else {
        console.log(yellow(`         refused: ${c.gates.find((g) => !g.pass)?.reason}`));
      }
      break;
    }
    case "incident.opened":
      console.log(red(bold(`\n  ${e.payload.incident.id} opened: ${e.payload.incident.ticketIds.length} tickets, ${SURFACE_LABELS[e.payload.incident.surface]}, severity ${e.payload.incident.severity}\n`)));
      break;
    case "incident.status_changed":
      console.log(bold(`  ${e.payload.incidentId}: ${e.payload.to.replace(/_/g, " ")}`) + dim(`  ${e.payload.note}`));
      break;
    case "tool.called": {
      const a = e.payload.entry;
      const outcome = a.decision === "denied" ? red(`DENIED: ${a.reason}`) : a.outcome === "error" ? red(`error: ${a.reason}`) : dim(a.resultSummary ?? "");
      console.log(`  ${dim(`[${a.identity}]`)} ${a.tool} ${dim(`L${a.level ?? "?"} ${a.adapter}`)}  ${outcome}`);
      break;
    }
    case "rootcause.ranked":
      console.log(bold("\n  Root-cause ranking"));
      for (const h of e.payload.hypotheses.slice(0, 4)) {
        console.log(`    ${(h.confidence * 100).toFixed(1).padStart(5)}%  ${h.label}`);
        for (const ev of h.evidence) console.log(dim(`            LR ${ev.lr.toFixed(2).padStart(5)}  ${ev.checked ? "" : "(not checked) "}${ev.observation}`));
      }
      if (e.payload.narrative) console.log(dim(`  ${e.payload.narrative}\n`));
      break;
    case "customers.identified":
      console.log(`  affected customers: ${bold(String(e.payload.ticketed.length + e.payload.silent.length))} (${e.payload.ticketed.length} contacted us, ${e.payload.silent.length} silent)`);
      break;
    case "credit.proposed":
      console.log(`  credit proposed: ${inr(e.payload.perCustomerInr)} × ${e.payload.customers} = ${bold(inr(e.payload.amountInr))} ${e.payload.withinAuthority ? green("(within authority)") : yellow("(above authority)")}`);
      break;
    case "approval.requested":
      console.log(yellow(bold(`\n  Approval ${e.payload.approval.id} requested from a human:`)));
      for (const line of e.payload.approval.caseSummary.split("\n")) console.log(yellow(`    ${line}`));
      console.log();
      break;
    case "approval.decided":
      console.log(bold(`  ${e.payload.approval.id} ${e.payload.approval.status} by ${e.payload.approval.decidedBy}`));
      break;
    case "credit.issued":
      console.log(green(bold(`  credit issued: ${inr(e.payload.amountInr)} (${e.payload.creditId}, ${e.payload.adapter})`)));
      break;
    default:
      break;
  }
}

runtime.bus.subscribe(print);
const done = new Promise<void>((resolve) => runtime.bus.subscribe((e) => e.type === "replay.finished" && resolve()));
await runtime.startReplay(id, speed);
await done;

const state = runtime.state();
const incident = state.incidentOrder.map((i) => state.incidents[i]!)[0];
if (decideArg && incident?.approvalId) {
  const [decision, amount] = decideArg.split(":");
  const body: DecisionBody = decision === "modify" ? { decision: "modify", amountInr: Number(amount) } : { decision: decision === "reject" ? "reject" : "approve" };
  await runtime.decide(incident.approvalId, body, "cli");
  await runtime.engineNow().whenIdle();
}

const final = runtime.state();
const summary = final.incidentOrder.map((i) => final.incidents[i]!);
console.log(bold("\nSummary"));
if (summary.length === 0) console.log("  No incident opened.");
for (const i of summary) {
  const voice = i.updates.filter((u) => u.channel === "voice").length;
  console.log(
    `  ${i.id}: ${i.status}; root cause ${i.rootCause ? `${i.rootCause.label} (${(i.rootCause.confidence * 100).toFixed(0)}%)` : "not identified"}; ` +
      `${i.linkedTicketIds.length} tickets linked; ${i.affected?.total ?? 0} affected (${i.affected?.silent.length ?? 0} silent); ` +
      `${i.updates.filter((u) => u.status === "sent").length} updates sent, ${voice} voice prepared; credit ${i.credit ? `${inr(i.credit.amountInr)} ${i.credit.status.replace("_", " ")}` : "none"}`,
  );
}
const audit = runtime.engineNow().audit.verify();
console.log(`  audit: ${audit.count} tool calls, hash chain ${audit.ok ? green("verified") : red("BROKEN")}`);
process.exit(0);
