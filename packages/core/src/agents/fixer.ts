import type { FixSessionEvent } from "@crisiscrew/contracts";
import { higher } from "../importance/assess";
import type { CodingEvent } from "../ports";
import { blamedRelease, patchFix, stage } from "../tools/fix";
import { runWorkflow } from "../workflows/graphs";
import type { AgentKit } from "./kit";

/**
 * Fix Agent: on a P1 whose likely cause is a release, it prepares the fix
 * while the on-call engineer is still on the phone. It gathers context,
 * starts a headless coding agent in a scratch clone, then (when the session
 * ends) runs the tests itself, opens a pull request for the code owners and
 * the on-call engineer to review, and shares an incident report. It never
 * merges or deploys: the engineer reviews, a human ships.
 */

const starting = new WeakMap<AgentKit, Set<string>>();

function started(kit: AgentKit): Set<string> {
  let set = starting.get(kit);
  if (!set) starting.set(kit, (set = new Set()));
  return set;
}

/** Starts the Fix Agent on an incident once, when it's important enough and a release is to blame. */
export function autofixIfNeeded(kit: AgentKit, incidentId: string): void {
  if (!kit.ports.fix || started(kit).has(incidentId) || kit.state().fixes[incidentId]) return;
  const incident = kit.state().incidents[incidentId];
  const level = incident?.importance?.level;
  const { minImportance, deployConfidence } = kit.policy.autofix;
  if (!incident || !level || higher(minImportance, level)) return;
  if (!blamedRelease(incident) || (incident.rootCause?.confidence ?? 0) < deployConfidence) return;
  // After the Issue Creator has filed it, so the fix can point at the engineering record.
  if (!incident.engineering) return;
  started(kit).add(incidentId);
  kit.spawn("fixer", () =>
    runWorkflow(
      kit.tracer,
      { workflow: "autofix", title: `Auto-fix ${incidentId}`, actor: "fixer", incidentId },
      "fix",
      { label: "Prepare the fix", actor: "fixer", description: "Gather context, clone the repository and start the coding agent." },
      () => begin(kit, incidentId),
      () => ({ outcome: `Coding session started for ${incidentId}`, incidentId }),
    ),
  );
}

async function begin(kit: AgentKit, incidentId: string): Promise<void> {
  kit.setAgent("fixer", "working", `Reading the tickets, the release and team knowledge for ${incidentId}`);
  const context = await kit.gate.call("fixer", "gather_fix_context", { incidentId });
  const fix = kit.state().fixes[incidentId];
  if (!context.ok || !fix?.repo) {
    kit.setAgent("fixer", "done", `No fix for ${incidentId}: ${context.ok ? (fix?.error ?? "no repository") : context.reason}`);
    return;
  }
  kit.setAgent("fixer", "working", `Cloning ${fix.repo.fullName} and starting the coding agent`);
  const session = await kit.gate.call("fixer", "start_fix_session", { incidentId });
  if (!session.ok) {
    patchFix(kit, incidentId, (f) => ({ ...stage(f, "workspace", "failed", session.reason, kit.now()), status: "failed", error: session.reason }));
    kit.setAgent("fixer", "done", `Couldn't start a session for ${incidentId}: ${session.reason}`);
    return;
  }
  kit.setAgent("fixer", "working", `${kit.state().fixes[incidentId]?.agent?.tool ?? "The coding agent"} is working on ${incidentId}`);
}

const clip = (text: string, max = 1_600) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** One event from a coding session: recorded on the incident's fix; the end of the session hands off to verification. */
export async function onCodingEvent(kit: AgentKit, sessionId: string, event: CodingEvent): Promise<void> {
  const fix = Object.values(kit.state().fixes).find((f) => f.agent?.sessionId === sessionId);
  if (!fix || fix.status !== "running") return;
  const incidentId = fix.incidentId;
  const at = kit.now();
  const push = (e: Omit<FixSessionEvent, "at">) => patchFix(kit, incidentId, (f) => ({ ...f, session: [...f.session, { ...e, at }] }));

  switch (event.type) {
    case "text":
      push({ kind: "text", title: clip(event.text, 600) });
      if (event.diagnosis) patchFix(kit, incidentId, (f) => ({ ...f, diagnosis: event.text }));
      return;
    case "tool":
      push({ kind: "tool", tool: event.tool, title: event.title, ...(event.detail ? { detail: clip(event.detail) } : {}), ...(event.ok !== undefined ? { ok: event.ok } : {}) });
      return;
    case "tests": {
      const run = { command: event.run.command, passed: event.run.passed, failed: event.run.failed, ok: event.run.ok, output: clip(event.run.output, 2_000), at };
      if (event.phase === "before") {
        patchFix(kit, incidentId, (f) =>
          stage(stage({ ...f, tests: { ...f.tests, before: run } }, "reproduce", run.ok ? "failed" : "done", run.ok ? "The new test passes: the bug isn't reproduced" : `Reproduced: ${run.failed} failing`, at), "patch", "running", "Editing the code", at),
        );
        kit.setAgent("fixer", "working", `Reproduced ${incidentId} with ${run.failed} failing test${run.failed === 1 ? "" : "s"}; patching`);
      } else {
        patchFix(kit, incidentId, (f) => stage({ ...f, tests: { ...f.tests, after: run } }, "patch", run.ok ? "done" : "running", `${run.passed} passed, ${run.failed} failed`, at));
      }
      return;
    }
    case "failed":
      patchFix(kit, incidentId, (f) => ({ ...stage(f, "patch", "failed", event.reason, at), status: "failed", error: event.reason }));
      kit.setAgent("fixer", "done", `The coding session for ${incidentId} failed: ${event.reason}`);
      return;
    case "done":
      patchFix(kit, incidentId, (f) => ({ ...(f.stages.patch.status === "done" ? f : stage(f, "patch", "done", "Session finished", at)), title: event.title, session: [...f.session, { kind: "text", title: clip(event.summary, 600), at }] }));
      await runWorkflow(
        kit.tracer,
        { workflow: "autofix", title: `Auto-fix ${incidentId}: review`, actor: "fixer", incidentId },
        "hand_off",
        { label: "Verify and hand off", actor: "fixer", description: "Run the tests, open the pull request, share the report." },
        () => handOff(kit, incidentId),
        () => ({ outcome: kit.state().fixes[incidentId]?.pullRequest ? `PR #${kit.state().fixes[incidentId]!.pullRequest!.number} ready for review` : "Not handed off", incidentId }),
      );
      return;
  }
}

/** The session ended: check its work, then put it in front of people. */
async function handOff(kit: AgentKit, incidentId: string): Promise<void> {
  kit.setAgent("fixer", "working", `Running the tests myself before ${incidentId}'s fix leaves the workspace`);
  const verified = await kit.gate.call("fixer", "verify_fix", { incidentId });
  const fix = kit.state().fixes[incidentId];
  if (!verified.ok || !fix?.tests.verified?.ok) {
    const why = verified.ok ? `${fix?.tests.verified?.failed ?? "some"} tests fail` : verified.reason;
    patchFix(kit, incidentId, (f) => ({ ...f, status: "failed", error: `not sent for review: ${why}` }));
    kit.setAgent("fixer", "done", `${incidentId}'s fix isn't sent for review: ${why}`);
    return;
  }
  kit.setAgent("fixer", "working", `Opening a pull request for ${incidentId}`);
  const pr = await kit.gate.call("fixer", "open_fix_pull_request", { incidentId });
  if (!pr.ok) {
    patchFix(kit, incidentId, (f) => ({ ...stage(f, "pull_request", "failed", pr.reason, kit.now()), status: "failed", error: pr.reason }));
    kit.setAgent("fixer", "done", `Couldn't open the pull request for ${incidentId}: ${pr.reason}`);
    return;
  }
  const number = (pr.result as { number: number }).number;
  kit.setAgent("fixer", "working", `Writing ${incidentId}'s report for the on-call engineer`);
  const report = await kit.gate.call("fixer", "publish_incident_report", { incidentId });
  const done = kit.state().fixes[incidentId]!;
  if (kit.state().incidents[incidentId]?.engineering) {
    await kit.gate.call("fixer", "update_engineering_incident", {
      incidentId,
      note: `Fix ready for review: pull request #${number} (${done.pullRequest?.url}) on ${done.branch}, ${done.tests.verified?.passed ?? 0} tests passing.${done.report ? ` Incident report: ${done.report.url}.` : ""} Nothing is merged or deployed without a human.`,
    });
  }
  kit.setAgent("fixer", "done", `PR #${number} is ready for review${report.ok ? ", and the report is shared" : ""}. It won't merge on its own`);
}
