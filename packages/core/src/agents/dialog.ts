import { recoveryCoverage, type CrisisState, type FixView, type IncidentView } from "@crisiscrew/contracts";
import type { CallDialog, DialogTurn } from "../ports";

/**
 * The on-call page as a conversation. The engineer can speak (the telephony
 * side turns speech into text) and CrisisCrew answers each turn from what it
 * knows at that moment: the impact, what changed in the blamed release, and
 * where the Fix Agent is. No language model: each answer is a template over
 * live state, so it can't say anything the engine doesn't know.
 */

const ACK = /\b(ack(nowledge[ds]?)?|i'?m on it|on it|i'?ll take it|taking it|got it,? mine)\b/;
const INTENTS: { name: Intent; test: RegExp }[] = [
  { name: "bye", test: /\b(bye|thanks|thank you|that'?s all|talk (soon|later)|i'?ll review)\b/ },
  { name: "report", test: /\b(report|doc|document|send me|write.?up|summary)\b/ },
  { name: "fix", test: /\b(roll ?back|revert|fix|patch|should i|do i need|what do you need)\b/ },
  { name: "cause", test: /\b(what changed|changed|release|diff|cause|why|root)\b/ },
  { name: "impact", test: /\b(how many|impact|customers|blast|affected|how bad|hit)\b/ },
  { name: "status", test: /\b(status|ready|done|pr|pull request|tests?)\b/ },
];
type Intent = "bye" | "report" | "fix" | "cause" | "impact" | "status";

const inr = (n: number) => `${Math.round(n).toLocaleString("en-IN")} rupees`;
const first = (name: string) => name.split(/\s+/)[0] ?? name;
const spoken = (id: string) => id.replace(/-/g, " ");

function impact(incident: IncidentView): string {
  const coverage = recoveryCoverage(incident);
  if (!coverage.confirmed) return "We haven't matched any complaint to a failed payment yet.";
  const value = (incident.impact?.customers ?? []).filter((c) => c.confidence === "confirmed").reduce((sum, c) => sum + c.amountInr, 0);
  return `${coverage.confirmed} customers are confirmed affected, ${inr(value)} in failed or stuck payments. ${coverage.complained} wrote in and ${coverage.silent} haven't noticed yet. The Recovery Agent is already messaging all of them, so support is covered.`;
}

function cause(incident: IncidentView, fix: FixView | undefined): string {
  const root = incident.rootCause;
  if (!root) return "The Investigator is still ranking the causes. I'll tell you as soon as it has one.";
  const head = `The likely cause is ${root.label}, at ${Math.round(root.confidence * 100)} percent confidence.`;
  if (fix?.diagnosis) return `${head} ${fix.diagnosis}`;
  if (fix?.releaseChange) return `${head} ${fix.releaseChange}`;
  return head;
}

function fixStatus(fix: FixView | undefined, incident: IncidentView): string {
  const rollback = incident.engineering?.change ? ` A rollback change, ${incident.engineering.change.id}, is also filed in Freshservice if you'd rather roll back first.` : "";
  if (!fix) return `No fix is under way yet, so the rollback is your call.${rollback}`;
  if (fix.status === "skipped") return `I can't fix this one in code: ${fix.error ?? "no repository is set up for the service"}.${rollback}`;
  if (fix.status === "failed") return `The Fix Agent stopped: ${fix.error ?? "it hit an error"}. This one needs you.${rollback}`;
  const reviewer = fix.people?.reviewers[0]?.name;
  const who = `You don't need to write the fix. `;
  if (fix.pullRequest) {
    return `${who}It's done: pull request ${fix.pullRequest.number} on ${fix.repo?.fullName ?? "the repository"}, with ${fix.tests.verified?.passed ?? fix.tests.after?.passed ?? "all"} tests passing. ${reviewer ? `${reviewer} is the reviewer. ` : ""}Your job is to review it.${rollback}`;
  }
  const where =
    fix.stages.verify.status === "running" ? "I'm running the tests myself now to check its work."
    : fix.stages.patch.status === "running" ? `${fix.agent?.tool === "opencode" ? "OpenCode" : "The coding agent"} reproduced the bug with ${fix.tests.before?.failed ?? "a"} failing test${fix.tests.before?.failed === 1 ? "" : "s"} and is patching it now.`
    : fix.stages.reproduce.status === "running" ? `${fix.agent?.tool === "opencode" ? "OpenCode" : "The coding agent"} is writing a test that reproduces the bug.`
    : fix.stages.workspace.status === "done" ? "The coding agent is starting on it."
    : "It's gathering context from the tickets and the release.";
  return `${who}The Fix Agent cloned ${fix.repo?.fullName ?? "the repository"} to branch ${fix.branch ?? "a fix branch"}. ${where} I'll send you the pull request for review${reviewer ? `, with ${reviewer} as reviewer` : ""}.${rollback}`;
}

function report(fix: FixView | undefined): string {
  if (fix?.report && fix.pullRequest) return `Both are on your phone now: the incident report is a Google Doc shared with you, and pull request ${fix.pullRequest.number} is assigned to you on GitHub.`;
  if (fix?.report) return "The incident report is in your inbox as a Google Doc. The pull request follows as soon as the tests pass.";
  if (fix?.pullRequest) return `Pull request ${fix.pullRequest.number} is assigned to you on GitHub, and I'm writing the report now. It'll be in your inbox in a moment.`;
  return "I'll send both the moment the tests pass: the report as a Google Doc, and the pull request on GitHub.";
}

/** The dialog for one page call. */
export function pageDialog(state: () => CrisisState, incidentId: string, responder: string): CallDialog {
  let acknowledged = false;
  return {
    respond(utterance: string): DialogTurn {
      const heard = utterance.toLowerCase();
      const view = state();
      const incident = view.incidents[incidentId];
      if (!incident) return { say: "That incident is no longer open. Goodbye.", end: true };
      const fix = view.fixes?.[incidentId];
      const ack = !acknowledged && (ACK.test(heard) || heard.trim() === "1");
      if (ack) acknowledged = true;
      const intent = INTENTS.find((i) => i.test.test(heard))?.name;
      const lead = ack ? `Thanks ${first(responder)}, ${spoken(incidentId)} is yours. ` : "";

      if (intent === "bye") return { say: `${lead}You're welcome, ${first(responder)}. I'll keep the customers updated. Goodbye.`, end: true, ...(ack ? { acknowledge: true } : {}) };
      const body =
        intent === "report" ? report(fix)
        : intent === "fix" ? fixStatus(fix, incident)
        : intent === "cause" ? cause(incident, fix)
        : intent === "impact" ? impact(incident)
        : intent === "status" ? fixStatus(fix, incident)
        : ack ? `${impact(incident)} Ask me what changed, or where the fix is.`
        : "I can tell you the impact, what changed in the release, or where the fix is.";
      return { say: `${lead}${body}`, ...(ack ? { acknowledge: true } : {}) };
    },
  };
}
