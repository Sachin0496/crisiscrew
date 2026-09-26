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
// Checked in order: the first match answers. The coding-agent questions come before "what changed" and "fix", which they overlap.
const INTENTS: { name: Intent; test: RegExp }[] = [
  { name: "bye", test: /\b(bye|goodbye|that'?s all|talk (soon|later)|i'?ll review)\b|^(ok(ay)?,? )?thanks?( you)?[.!]*$/ },
  { name: "report", test: /\b(report|google doc|document|write.?up|summary)\b/ },
  { name: "security", test: /\b(secur\w*|safe|secrets?|vulnerab\w*|scan)\b/ },
  { name: "tests", test: /\b(tests?|testing|failing|passing|pass|reproduc\w*)\b/ },
  { name: "files", test: /\b(files?|lines?|diff|patch(ed)?|which code|what code|what did (it|the agent) (change|fix|edit)|code change)\b/ },
  { name: "review", test: /\b(pull request|pr|review\w*|merge|approve|github)\b/ },
  { name: "eta", test: /\b(how long|when will|eta|how much longer|minutes?)\b/ },
  { name: "rollback", test: /\b(roll ?back|revert|should i|do i need|what do you need)\b/ },
  { name: "agent", test: /\b(cod(e|ing)|agent|open ?code|developer|fix(ing|es)?|working on|doing|progress|status|ready|done)\b/ },
  { name: "cause", test: /\b(what changed|changed|release|cause|why|root|broke)\b/ },
  { name: "impact", test: /\b(how many|impact|customers|blast|affected|how bad|hit)\b/ },
];
type Intent = "bye" | "report" | "security" | "tests" | "files" | "review" | "eta" | "rollback" | "agent" | "cause" | "impact";

const agentName = (fix: FixView | undefined) => (fix?.agent?.tool === "opencode" ? "OpenCode" : "The coding agent");

/** What the coding agent is doing at this moment: its latest step, in words. */
function liveStep(fix: FixView): string {
  const last = fix.session.at(-1);
  return last ? ` Its latest step: ${last.title.replace(/\s+/g, " ").slice(0, 120)}.` : "";
}

function tests(fix: FixView | undefined): string {
  if (!fix) return "No fix is under way yet, so no tests have run.";
  const { before, after, verified } = fix.tests;
  const parts = [
    before ? `${agentName(fix)} wrote a test that reproduces the bug: ${before.failed} failing before the patch.` : "",
    after ? `After its patch, ${after.passed} pass and ${after.failed} fail.` : "",
    verified ? `I re-ran the suite myself: ${verified.passed} passed, ${verified.failed} failed${verified.ok ? ", so it's verified" : ""}.` : "",
  ].filter(Boolean);
  if (parts.length) return parts.join(" ");
  return fix.stages.reproduce.status === "running" ? `${agentName(fix)} is writing a test that reproduces the bug right now.` : "The tests haven't run yet. The agent is still getting set up.";
}

function files(fix: FixView | undefined): string {
  if (!fix) return "Nothing has been changed yet: no fix is under way.";
  if (fix.diff?.files.length) {
    const list = fix.diff.files.slice(0, 3).map((f) => `${f.path.split("/").pop()}, plus ${f.additions} minus ${f.deletions}`).join("; ");
    return `The patch touches ${fix.diff.files.length} ${fix.diff.files.length === 1 ? "file" : "files"}: ${list}.${fix.diagnosis ? ` ${fix.diagnosis}` : ""}`;
  }
  if (fix.diagnosis) return `${fix.diagnosis} The patch isn't final yet.${liveStep(fix)}`;
  return `${agentName(fix)} hasn't changed any code yet.${liveStep(fix)}`;
}

function review(fix: FixView | undefined): string {
  if (!fix) return "There's no pull request yet, because no fix is under way.";
  const reviewers = fix.people?.reviewers.map((r) => r.name) ?? [];
  if (fix.pullRequest) return `Pull request ${fix.pullRequest.number} is open on ${fix.repo?.fullName ?? "GitHub"}: ${fix.pullRequest.title}. ${reviewers.length ? `${reviewers.join(" and ")} ${reviewers.length === 1 ? "is" : "are"} the code owner reviewers, ` : ""}and you're the assignee. Nothing merges without a human.`;
  return `The pull request opens as soon as the tests and security checks pass${reviewers.length ? `, with ${reviewers.join(" and ")} as reviewer` : ""}. Nothing merges without a human.`;
}

function security(fix: FixView | undefined): string {
  if (!fix?.security) return fix ? "The security checks run once the patch is verified. They're deterministic rules, no model in the loop." : "No fix is under way, so there's nothing to scan yet.";
  const { findings, addedLines, rules, ok } = fix.security;
  if (ok && findings.length === 0) return `Clean: ${rules} deterministic rules over the ${addedLines} added lines, no secrets, no disabled TLS, no SQL built from strings.`;
  const p1 = findings.filter((f) => f.severity === "P1").length;
  return `${findings.length} ${findings.length === 1 ? "finding" : "findings"} on the ${addedLines} added lines${p1 ? `, ${p1} of them P1, which blocks the pull request` : ", none blocking"}.`;
}

function eta(fix: FixView | undefined): string {
  if (!fix) return "No fix is under way, so there's no estimate.";
  if (fix.pullRequest) return "It's already done: the pull request is waiting for your review.";
  const next = (["reproduce", "patch", "verify", "security", "pull_request"] as const).filter((s) => fix.stages[s].status !== "done" && fix.stages[s].status !== "skipped").length;
  return `About ${Math.max(1, next)} ${next <= 1 ? "minute" : "minutes"}: ${next} ${next === 1 ? "step is" : "steps are"} left before the pull request.${liveStep(fix)}`;
}

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
      const onCode = fix && fix.status === "running" ? " The Fix Agent is already working on the code: ask me what it's doing, the tests, or the pull request." : fix?.pullRequest ? " The Fix Agent's pull request is ready for your review." : " Ask me what changed, or where the fix is.";
      // Questions about the coding agent, and anything the rules don't recognise, are open: a voice that can reason answers them from facts().
      const open = !intent || ["security", "tests", "files", "review", "eta", "agent", "rollback"].includes(intent);
      const body =
        intent === "report" ? report(fix)
        : intent === "security" ? security(fix)
        : intent === "tests" ? tests(fix)
        : intent === "files" ? files(fix)
        : intent === "review" ? review(fix)
        : intent === "eta" ? eta(fix)
        : intent === "rollback" ? fixStatus(fix, incident)
        : intent === "agent" ? `${fixStatus(fix, incident)}${fix && !fix.pullRequest ? liveStep(fix) : ""}`
        : intent === "cause" ? cause(incident, fix)
        : intent === "impact" ? impact(incident)
        : ack ? `${impact(incident)}${onCode}`
        : "I can tell you the impact, the cause, or what the Fix Agent is doing: its tests, its code change, or the pull request.";
      return { say: `${lead}${body}`, ...(ack ? { acknowledge: true } : {}), ...(open && !(ack && !intent) ? { open: true } : {}) };
    },
    facts: () => callFacts(state(), incidentId, responder),
  };
}

const clip = (text: string | undefined, n: number) => (text ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** Everything the call may say about the incident and its fix, as plain text for a model to answer from. */
export function callFacts(view: CrisisState, incidentId: string, responder: string): string {
  const incident = view.incidents[incidentId];
  if (!incident) return `Incident ${incidentId} is no longer open.`;
  const fix = view.fixes?.[incidentId];
  const coverage = recoveryCoverage(incident);
  const lines = [
    `On-call engineer on the phone: ${responder}.`,
    `Incident ${incident.id}: ${incident.importance?.level ?? "unrated"}, area ${incident.surface.replace(/_/g, " ")}, status ${incident.status.replace(/_/g, " ")}.`,
    `Customers: ${coverage.confirmed} confirmed affected (${coverage.complained} complained, ${coverage.silent} silent); ${coverage.recovered} recovered, ${coverage.needsHuman} waiting for a human decision.`,
    incident.rootCause ? `Likely cause: ${incident.rootCause.label}, ${Math.round(incident.rootCause.confidence * 100)} percent confidence.` : "Likely cause: not ranked yet.",
    incident.engineering ? `Freshservice incident ${incident.engineering.id}${incident.engineering.change ? `, rollback change ${incident.engineering.change.id} filed` : ""}.` : "",
    incident.paging ? `Paging: ${incident.paging.status}${incident.paging.acknowledgedBy ? `, acknowledged by ${incident.paging.acknowledgedBy}` : ""}.` : "",
  ];
  if (!fix) {
    lines.push("Fix Agent: not started; no code is being changed.");
  } else {
    const stages = Object.entries(fix.stages).map(([name, s]) => `${name.replace(/_/g, " ")} ${s.status}${s.detail ? ` (${clip(s.detail, 90)})` : ""}`).join("; ");
    lines.push(
      `Fix Agent: status ${fix.status.replace(/_/g, " ")}, coding agent ${fix.agent?.tool ?? "unknown"}${fix.agent?.model ? ` (${fix.agent.model})` : ""}, repository ${fix.repo?.fullName ?? "unknown"}, branch ${fix.branch ?? "not created"}.`,
      `Fix stages: ${stages}.`,
      fix.releaseChange ? `What the blamed release changed: ${clip(fix.releaseChange, 240)}` : "",
      fix.diagnosis ? `Coding agent's diagnosis: ${clip(fix.diagnosis, 300)}` : "",
      fix.diff ? `Diff: ${fix.diff.files.map((f) => `${f.path} +${f.additions} -${f.deletions}`).join(", ")}; commit ${fix.diff.sha.slice(0, 7)}.` : "Diff: none yet.",
      fix.tests.before ? `Tests before the patch: ${fix.tests.before.passed} passed, ${fix.tests.before.failed} failed (${fix.tests.before.command}).` : "",
      fix.tests.after ? `Tests after the patch: ${fix.tests.after.passed} passed, ${fix.tests.after.failed} failed.` : "",
      fix.tests.verified ? `Tests re-run by CrisisCrew itself: ${fix.tests.verified.passed} passed, ${fix.tests.verified.failed} failed.` : "",
      fix.security ? `Security checks: ${fix.security.rules} rules over ${fix.security.addedLines} added lines, ${fix.security.findings.length} findings${fix.security.findings.length ? ` (${fix.security.findings.map((f) => `${f.severity} ${f.rule} in ${f.file}`).join("; ")})` : ""}, ${fix.security.ok ? "passed" : "blocking"}.` : "",
      fix.pullRequest ? `Pull request ${fix.pullRequest.number}: "${clip(fix.pullRequest.title, 120)}", reviewers ${fix.pullRequest.reviewers.join(", ") || "none"}, assignees ${fix.pullRequest.assignees.join(", ") || "none"}. Nothing merges without a human.` : "Pull request: not opened yet.",
      fix.people?.reviewers.length ? `Code owner reviewers: ${fix.people.reviewers.map((r) => r.name).join(", ")}.` : "",
      fix.report ? `Incident report: "${clip(fix.report.title, 100)}", shared with ${fix.report.sharedWith.join(", ")}.` : "",
      fix.context.length ? `Context the Fix Agent read: ${fix.context.map((c) => `${c.kind}: ${clip(c.title, 60)}`).join("; ")}.` : "",
      fix.error ? `Fix Agent error: ${clip(fix.error, 160)}.` : "",
      `The coding agent's latest steps, oldest first: ${fix.session.slice(-8).map((e) => `${e.tool ? `[${e.tool}] ` : ""}${clip(e.title, 90)}${e.detail ? `: ${clip(e.detail, 110)}` : ""}`).join(" | ") || "none yet"}.`,
    );
  }
  return lines.filter(Boolean).join("\n");
}
