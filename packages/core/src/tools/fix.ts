import { FIX_STAGES, recoveryCoverage, type CrisisState, type EventInput, type FixSource, type FixStage, type FixView, type IncidentView, type Ticket } from "@crisiscrew/contracts";
import { z } from "zod";
import type { ToolDef } from "../policy/gate";
import type { DocBlock, FixPorts, RepoInfo } from "../ports";
import type { ToolCtx } from "./definitions";

/**
 * The Fix Agent's tools. It reads context (L0), then works only in a scratch
 * clone and on a branch of its own (L1): it can open a pull request and share
 * a report, and nothing here can merge, deploy or touch the default branch.
 */

type FixTool = ToolDef<ToolCtx>;
const idOnly = z.object({ incidentId: z.string().min(1) });
const fixed = (level: 0 | 1) => () => level;

type FixHost = { state(): CrisisState; emit(event: EventInput): void; now(): number };

/** Applies a change to an incident's fix and emits it whole. */
export function patchFix(host: FixHost, incidentId: string, change: (fix: FixView) => FixView): FixView | undefined {
  const current = host.state().fixes[incidentId];
  if (!current) return undefined;
  const next = { ...change(current), updatedAt: host.now() };
  host.emit({ type: "fix.updated", payload: { incidentId, fix: next } });
  return next;
}

/** Marks one stage (and when it changed). */
export function stage(fix: FixView, name: FixStage, status: FixView["stages"][FixStage]["status"], detail: string | undefined, at: number): FixView {
  return { ...fix, stages: { ...fix.stages, [name]: { status, ...(detail ? { detail } : {}), at } } };
}

export function newFix(incidentId: string, service: string, now: number): FixView {
  const stages = Object.fromEntries(FIX_STAGES.map((s) => [s, { status: "pending" }])) as FixView["stages"];
  return { incidentId, status: "running", startedAt: now, updatedAt: now, service, stages, context: [], session: [], tests: {} };
}

function portsOf(ctx: ToolCtx): FixPorts {
  if (!ctx.ports.fix) throw new Error("the Fix Agent's tools aren't configured");
  return ctx.ports.fix;
}

function incidentOf(ctx: ToolCtx, id: string): IncidentView {
  const incident = ctx.state().incidents[id];
  if (!incident) throw new Error(`no incident ${id}`);
  return incident;
}

function ticketsOf(ctx: ToolCtx, incident: IncidentView): Ticket[] {
  const ids = new Set([...incident.ticketIds, ...incident.linkedTicketIds]);
  return [...ids].map((id) => ctx.state().tickets[id]?.ticket).filter((t): t is Ticket => Boolean(t));
}

/** The release the investigation blames: its service and version. */
export function blamedRelease(incident: IncidentView): { service: string; version: string } | null {
  const top = incident.hypotheses.find((h) => h.id === incident.rootCause?.hypothesisId);
  if (top?.kind !== "deploy") return null;
  const [service, version] = top.subject.split("@");
  return service && version ? { service, version } : null;
}

/** "GATEWAY_TIMEOUT_MS" → "gateway timeout ms"; camelCase too. */
function words(identifier: string): string[] {
  return identifier
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}
const STOP = new Set(["const", "export", "let", "var", "the", "and", "for", "import", "from", "return", "function", "async", "await", "new", "true", "false", "null", "this", "ms"]);

/**
 * One sentence on what a release changed, from its diff: the first changed
 * code line and what it became. "src/config.ts: GATEWAY_TIMEOUT_MS went from 15_000 to 1_500."
 */
export function summarizeChange(files: { path: string; patch: string }[]): { sentence: string; keywords: string[] } {
  // Version bumps, lockfiles and changelogs change with every release: the code says what this one did.
  const code = files.filter((f) => !/(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|CHANGELOG(\.md)?)$/i.test(f.path));
  for (const file of code) {
    const lines = file.patch.split("\n");
    const removed = lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).map((l) => l.slice(1).trim()).filter((l) => l && !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*"));
    const added = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1).trim()).filter((l) => l && !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*"));
    if (!removed.length || !added.length) continue;
    const before = removed[0]!;
    const after = added[0]!;
    const assign = /(?:const|let|var)?\s*([A-Za-z_][\w.]*)\s*[=:]\s*(.+?);?$/;
    const b = assign.exec(before.replace(/^export\s+/, ""));
    const a = assign.exec(after.replace(/^export\s+/, ""));
    if (b && a && b[1] === a[1]) {
      return { sentence: `The release changed ${a[1]} in ${file.path} from ${b[2]} to ${a[2]}.`, keywords: words(a[1]!) };
    }
    return { sentence: `The release changed ${file.path}: "${before}" became "${after}".`, keywords: [...words(before), ...words(after)].slice(0, 4) };
  }
  return { sentence: files.length ? `The release changed ${files.map((f) => f.path).join(", ")}.` : "The release diff is empty.", keywords: [] };
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/** The task the coding agent gets: everything it needs, and the limits of its job. */
function promptFor(input: { incident: IncidentView; repo: RepoInfo; release: { version: string; base: string }; symptoms: string[]; change: string; notes: string[] }): string {
  return [
    `You are fixing production incident ${input.incident.id} in ${input.repo.fullName}.`,
    `Customers report: ${input.symptoms.map((s) => `"${s}"`).join("; ")}.`,
    `It started after release v${input.release.version} (previous: ${input.release.base}). ${input.change}`,
    ...(input.notes.length ? [`What the team already knows: ${input.notes.join(" ")}`] : []),
    "1. First write a test that reproduces the customers' problem, and run the tests to see it fail.",
    "2. Make the smallest change that fixes it. Don't touch unrelated code.",
    `3. Run the tests (${input.repo.testCommand}) until they all pass.`,
    "Never merge, deploy or push to the default branch. Explain the cause in one paragraph.",
  ].join("\n");
}

/** The report, as document blocks: what happened, who was hurt, why, the fix, and what's needed from the reader. */
function reportBlocks(ctx: ToolCtx, incident: IncidentView, fix: FixView): DocBlock[] {
  const coverage = recoveryCoverage(incident);
  const tickets = ticketsOf(ctx, incident);
  const value = (incident.impact?.customers ?? []).filter((c) => c.confidence === "confirmed").reduce((sum, c) => sum + c.amountInr, 0);
  const pr = fix.pullRequest!;
  const reviewer = fix.people?.reviewers.map((r) => r.name).join(", ") || "the code owners";
  const timeline = incident.timeline.slice(0, 6).map((t) => `${new Date(t.at).toISOString().slice(11, 19)} UTC · ${t.note}`);
  return [
    { kind: "paragraph", text: `Written by CrisisCrew for the on-call engineer. ${incident.importance?.level ?? ""} · opened ${new Date(incident.openedAt).toISOString().replace("T", " ").slice(0, 16)} UTC.` },
    { kind: "heading", text: "Summary" },
    {
      kind: "paragraph",
      text: `${tickets.length} customers reported failed payments within minutes of each other. CrisisCrew grouped them into ${incident.id}, traced them to ${incident.rootCause?.label ?? "an unknown cause"}, and prepared a fix for your review. You don't need to write code: review pull request #${pr.number}.`,
    },
    { kind: "heading", text: "Customer impact" },
    {
      kind: "bullets",
      items: [
        `${coverage.confirmed} customers confirmed affected: ${coverage.complained} wrote in, ${coverage.silent} never noticed.`,
        `₹${Math.round(value).toLocaleString("en-IN")} in failed or stuck payments.`,
        `Recovery coverage ${coverage.recovered}/${coverage.confirmed}${coverage.needsHuman ? `; ${coverage.needsHuman} credits wait for a human` : ""}.`,
      ],
    },
    { kind: "heading", text: "Root cause" },
    { kind: "paragraph", text: fix.diagnosis ?? fix.releaseChange ?? incident.rootCause?.label ?? "Unknown." },
    { kind: "heading", text: "The fix" },
    {
      kind: "bullets",
      items: [
        `Branch ${fix.branch} on ${fix.repo?.fullName}, written by ${fix.agent?.tool ?? "a coding agent"} (${fix.agent?.model ?? "model unknown"}) in headless mode.`,
        `Reproduced first: ${fix.tests.before ? `${fix.tests.before.failed} failing test${fix.tests.before.failed === 1 ? "" : "s"} before the change` : "no failing test recorded"}.`,
        `Verified by CrisisCrew: ${fix.tests.verified?.passed ?? 0} passed, ${fix.tests.verified?.failed ?? 0} failed.`,
        ...(fix.diff?.files ?? []).map((f) => `${f.path} (+${f.additions} −${f.deletions})`),
      ],
    },
    { kind: "link", text: `Pull request #${pr.number}: ${pr.title}`, url: pr.url },
    { kind: "heading", text: "What we need from you" },
    { kind: "bullets", items: [`Review pull request #${pr.number}. ${reviewer} must approve it too (code owners).`, "Merge and deploy when you're satisfied, or roll back instead: the rollback change is filed in Freshservice.", "Nothing merges or deploys without a human."] },
    { kind: "heading", text: "Timeline" },
    { kind: "bullets", items: timeline.length ? timeline : ["No timeline yet."] },
    ...(incident.engineering ? [{ kind: "link" as const, text: `Freshservice incident ${incident.engineering.id}`, url: incident.engineering.url ?? "" }] : []),
  ];
}

export function fixTools(): FixTool[] {
  return [
    {
      name: "gather_fix_context",
      description:
        "Read everything the fix needs before touching code: the incident's complaints, the engineering record, what the blamed release changed, error rates, team knowledge (Slack, runbooks), whether the service is a microservice, and who reviews its code.",
      input: idOnly,
      level: fixed(0),
      adapter: (ctx) => ctx.ports.fix?.codeHost.adapter ?? "off",
      condition(args, ctx) {
        const { incidentId } = args as { incidentId: string };
        const incident = ctx.state().incidents[incidentId];
        if (!incident) return `no incident ${incidentId}`;
        if (!ctx.ports.fix) return "the Fix Agent's tools aren't configured";
        if (!blamedRelease(incident)) return "no release is the likely cause, so there's no code change to fix";
        return ctx.state().fixes[incidentId]?.stages.context.status === "done" ? "context already gathered" : null;
      },
      async run(args, ctx) {
        const { incidentId } = args as { incidentId: string };
        const ports = portsOf(ctx);
        const incident = incidentOf(ctx, incidentId);
        const release = blamedRelease(incident)!;
        const at = ctx.now();
        const host = { state: ctx.state, emit: ctx.emit, now: ctx.now };
        if (!ctx.state().fixes[incidentId]) ctx.emit({ type: "fix.updated", payload: { incidentId, fix: newFix(incidentId, release.service, at) } });
        patchFix(host, incidentId, (f) => stage(f, "context", "running", "Reading tickets, the release and team knowledge", at));

        const repo = await ports.codeHost.repoFor(release.service);
        if (!repo) {
          patchFix(host, incidentId, (f) => ({ ...stage(f, "context", "done", `No repository for ${release.service}`, ctx.now()), status: "skipped", error: `no repository is set up for ${release.service}` }));
          return { repo: null };
        }
        const deploys = await ctx.ports.deployments.recent(release.service, 72 * 3_600_000);
        const previous = deploys.filter((d) => d.version !== release.version && d.at < (deploys.find((x) => x.version === release.version)?.at ?? Infinity)).sort((a, b) => b.at - a.at)[0];
        const base = previous ? `v${previous.version}` : repo.defaultBranch;
        const blamed = deploys.find((d) => d.version === release.version);
        const diff = await ports.codeHost.compare(repo, base, `v${release.version}`);
        const change = summarizeChange(diff.files);

        const tickets = ticketsOf(ctx, incident);
        const symptoms = tickets.slice(0, 4).map((t) => t.body.slice(0, 120));
        const rates = await ctx.ports.metrics.errorRates(release.service, (blamed?.at ?? at) - 30 * 60_000, at);
        const before = rates.filter((r) => r.at < (blamed?.at ?? at));
        const after = rates.filter((r) => r.at >= (blamed?.at ?? at));
        const mean = (xs: { rate: number }[]) => (xs.length ? xs.reduce((s, r) => s + r.rate, 0) / xs.length : 0);
        const query = [...new Set(change.keywords)].slice(0, 3).join(" ") || release.service;
        const knowledge = await ports.knowledge.search(query);

        const oncall = incident.paging?.attempts[0];
        const responders = await ctx.ports.oncall.whoIsOnCall(release.service).catch(() => []);
        const responder = responders.find((r) => r.name === oncall?.responder) ?? responders[0];
        const oncallUser = responder?.email ? await ports.codeHost.userByEmail(responder.email) : null;
        const reviewers = (await ports.codeHost.users(repo.owners)).filter((u) => u.login !== oncallUser?.login);

        const sources: FixSource[] = [
          { kind: "tickets", title: `${tickets.length} customer tickets`, detail: symptoms.slice(0, 2).map((s) => `“${s}”`).join(" ") },
          ...(incident.engineering ? [{ kind: "engineering" as const, title: `Freshservice ${incident.engineering.id}`, detail: `${incident.rootCause?.label ?? "cause unknown"} · ${Math.round((incident.rootCause?.confidence ?? 0) * 100)}%`, ...(incident.engineering.url ? { url: incident.engineering.url } : {}) }] : []),
          { kind: "release", title: `Release diff ${base} → v${release.version}`, detail: `${blamed?.message ?? ""}${blamed ? ` · ${blamed.author}` : ""}. ${change.sentence}` },
          ...(rates.length ? [{ kind: "metrics" as const, title: `${release.service} error rate`, detail: `${pct(mean(before))} before the release, ${pct(mean(after))} after` }] : []),
          ...knowledge.map((k) => ({ kind: k.source === "slack" ? ("slack" as const) : ("runbook" as const), title: k.title, detail: k.snippet, ...(k.url ? { url: k.url } : {}) })),
          {
            kind: "architecture",
            title: repo.architecture === "microservice" ? "Microservice: one repository" : "Monolith",
            detail: repo.architecture === "microservice" ? `${release.service} lives in ${repo.fullName}; the fix stays inside it.` : "A monolith would need the code knowledge graph to find the right module.",
          },
        ];
        const prompt = promptFor({ incident, repo, release: { version: release.version, base }, symptoms, change: change.sentence, notes: knowledge.slice(0, 2).map((k) => k.snippet) });
        patchFix(host, incidentId, (f) => ({
          ...stage(f, "context", "done", `${sources.length} sources`, ctx.now()),
          repo: { fullName: repo.fullName, url: repo.url, defaultBranch: repo.defaultBranch, architecture: repo.architecture },
          context: sources,
          releaseChange: change.sentence,
          prompt,
          testCommand: repo.testCommand,
          people: {
            ...(responder ? { oncall: { name: responder.name, ...(responder.email ? { email: responder.email } : {}), ...(oncallUser ? { login: oncallUser.login } : {}) } } : {}),
            reviewers: reviewers.map((r) => ({ name: r.name, login: r.login, ...(r.email ? { email: r.email } : {}) })),
          },
        }));
        return { repo: repo.fullName, sources: sources.length, change: change.sentence, knowledge: knowledge.map((k) => k.snippet) };
      },
      summarize: (r) => {
        const res = r as { repo: string | null; sources?: number };
        return res.repo ? `${res.sources} sources; repository ${res.repo}` : "no repository for the service";
      },
      // Complaints, commit messages and chat are written by people outside the policy: screened, and only ever data.
      untrusted: (r) => (r as { change?: string; knowledge?: string[] }).knowledge?.concat((r as { change?: string }).change ?? "") ?? [],
    },
    {
      name: "start_fix_session",
      description: "Clone the service's repository into a scratch workspace on a new branch, and start a headless coding agent (OpenCode) on the incident. It returns at once; the session reports as it goes.",
      input: idOnly,
      level: fixed(1),
      adapter: (ctx) => ctx.ports.fix?.coding.adapter ?? "off",
      condition(args, ctx) {
        const fix = ctx.state().fixes[(args as { incidentId: string }).incidentId];
        if (!fix || fix.stages.context.status !== "done" || !fix.repo) return "gather the context first";
        return fix.agent?.sessionId ? "a session is already running" : null;
      },
      async run(args, ctx) {
        const { incidentId } = args as { incidentId: string };
        const ports = portsOf(ctx);
        const host = { state: ctx.state, emit: ctx.emit, now: ctx.now };
        const fix = ctx.state().fixes[incidentId]!;
        const repo = (await ports.codeHost.repoFor(fix.service))!;
        const branch = `crisiscrew/${incidentId.toLowerCase()}-fix`;
        patchFix(host, incidentId, (f) => stage({ ...f, branch }, "workspace", "running", `git clone ${repo.fullName}`, ctx.now()));
        const { dir } = await ports.workspace.checkout(repo, branch);
        const { sessionId } = await ports.coding.start({ dir, prompt: fix.prompt ?? "", testCommand: repo.testCommand });
        patchFix(host, incidentId, (f) =>
          stage(stage({ ...f, workdir: dir, agent: { tool: ports.coding.tool, model: ports.coding.model, sessionId } }, "workspace", "done", `${repo.fullName} @ ${branch}`, ctx.now()), "reproduce", "running", "Writing a test that reproduces the complaints", ctx.now()),
        );
        return { sessionId, branch };
      },
      summarize: (r) => `session ${(r as { sessionId: string }).sessionId} on ${(r as { branch: string }).branch}`,
    },
    {
      name: "verify_fix",
      description: "Run the repository's tests in the workspace, independently of the coding agent, before anything leaves it.",
      input: idOnly,
      level: fixed(1),
      adapter: (ctx) => ctx.ports.fix?.workspace.adapter ?? "off",
      condition(args, ctx) {
        const fix = ctx.state().fixes[(args as { incidentId: string }).incidentId];
        if (!fix?.workdir) return "there's no workspace";
        return fix.stages.patch.status === "done" ? null : "the coding agent hasn't finished";
      },
      async run(args, ctx) {
        const { incidentId } = args as { incidentId: string };
        const host = { state: ctx.state, emit: ctx.emit, now: ctx.now };
        const fix = ctx.state().fixes[incidentId]!;
        patchFix(host, incidentId, (f) => stage(f, "verify", "running", fix.testCommand, ctx.now()));
        const run = await portsOf(ctx).workspace.test(fix.workdir!, fix.testCommand ?? "npm test");
        const verified = { command: run.command, passed: run.passed, failed: run.failed, ok: run.ok, output: run.output.slice(-2_000), at: ctx.now() };
        patchFix(host, incidentId, (f) => stage({ ...f, tests: { ...f.tests, verified } }, "verify", run.ok ? "done" : "failed", `${run.passed} passed, ${run.failed} failed`, ctx.now()));
        return verified;
      },
      summarize: (r) => `${(r as { passed: number }).passed} passed, ${(r as { failed: number }).failed} failed`,
    },
    {
      name: "open_fix_pull_request",
      description: "Commit the fix on its own branch, push it, and open a pull request with the code owners as reviewers and the on-call engineer assigned. Only after CrisisCrew's own test run passed. It can never merge.",
      input: idOnly,
      level: fixed(1),
      adapter: (ctx) => ctx.ports.fix?.codeHost.adapter ?? "off",
      condition(args, ctx) {
        const fix = ctx.state().fixes[(args as { incidentId: string }).incidentId];
        if (!fix?.workdir || !fix.branch) return "there's no workspace";
        if (fix.pullRequest) return `already opened as #${fix.pullRequest.number}`;
        if (!fix.tests.verified) return "the tests haven't been verified";
        return fix.tests.verified.ok ? null : `the tests fail (${fix.tests.verified.failed} failing): nothing goes to review`;
      },
      async run(args, ctx) {
        const { incidentId } = args as { incidentId: string };
        const ports = portsOf(ctx);
        const host = { state: ctx.state, emit: ctx.emit, now: ctx.now };
        const incident = incidentOf(ctx, incidentId);
        const fix = ctx.state().fixes[incidentId]!;
        patchFix(host, incidentId, (f) => stage(f, "pull_request", "running", "Commit, push, open for review", ctx.now()));
        const repo = (await ports.codeHost.repoFor(fix.service))!;
        const title = fix.title ?? `fix(${fix.service}): ${incident.id}`;
        const pushed = await ports.workspace.commitAndPush(fix.workdir!, fix.branch!, `${title}\n\nFixes ${incident.id}. Written by ${fix.agent?.tool ?? "a coding agent"} for CrisisCrew's Fix Agent.`);
        const reviewers = fix.people?.reviewers.map((r) => r.login) ?? [];
        const assignees = fix.people?.oncall?.login ? [fix.people.oncall.login] : [];
        const body = [
          `## ${incident.id}: ${incident.rootCause?.label ?? "fix"}`,
          `**Why:** ${fix.diagnosis ?? fix.releaseChange ?? ""}`,
          `**Customer impact:** ${recoveryCoverage(incident).confirmed} customers affected (${ticketsOf(ctx, incident).length} complaints).`,
          `**Reproduced:** ${fix.tests.before?.failed ?? 0} failing test(s) before the change. **Verified by CrisisCrew:** ${fix.tests.verified!.passed} passed, ${fix.tests.verified!.failed} failed.`,
          `**Written by:** ${fix.agent?.tool} (${fix.agent?.model}), headless, from CrisisCrew's context.`,
          "",
          "> Opened by CrisisCrew's Fix Agent. It will not be merged or deployed automatically: that's the reviewer's call.",
        ].join("\n");
        const pr = await ports.codeHost.openPullRequest(repo, { branch: fix.branch!, title, body, reviewers, assignees });
        patchFix(host, incidentId, (f) =>
          stage({ ...f, diff: { files: pushed.files, patch: pushed.patch.slice(0, 12_000), sha: pushed.sha }, pullRequest: { ...pr, title, reviewers, assignees } }, "pull_request", "done", `#${pr.number}`, ctx.now()),
        );
        return { number: pr.number, url: pr.url, reviewers, assignees };
      },
      summarize: (r) => `opened #${(r as { number: number }).number}; review requested from ${(r as { reviewers: string[] }).reviewers.join(", ") || "nobody"}`,
    },
    {
      name: "publish_incident_report",
      description: "Write the incident report (impact, cause, the fix and what's needed from the reader) as a shared document, and share it with the on-call engineer and the reviewers.",
      input: idOnly,
      level: fixed(1),
      adapter: (ctx) => ctx.ports.fix?.docs.adapter ?? "off",
      condition(args, ctx) {
        const fix = ctx.state().fixes[(args as { incidentId: string }).incidentId];
        if (!fix?.pullRequest) return "the pull request isn't open yet";
        return fix.report ? "already published" : null;
      },
      async run(args, ctx) {
        const { incidentId } = args as { incidentId: string };
        const host = { state: ctx.state, emit: ctx.emit, now: ctx.now };
        const incident = incidentOf(ctx, incidentId);
        const fix = ctx.state().fixes[incidentId]!;
        patchFix(host, incidentId, (f) => stage(f, "report", "running", "Writing the report", ctx.now()));
        const title = `${incident.id} · ${incident.rootCause?.label ?? "Incident"} · incident report`;
        const shareWith = [
          ...(fix.people?.oncall?.email ? [{ email: fix.people.oncall.email, role: "writer" as const }] : []),
          ...(fix.people?.reviewers ?? []).filter((r) => r.email).map((r) => ({ email: r.email!, role: "commenter" as const })),
        ];
        const doc = await portsOf(ctx).docs.publish({
          title,
          blocks: reportBlocks(ctx, incident, fix),
          shareWith,
          message: `CrisisCrew: ${incident.id} is yours. The fix is ready for review as pull request #${fix.pullRequest!.number}.`,
        });
        patchFix(host, incidentId, (f) => ({
          ...stage({ ...f, report: { ...doc, title, sharedWith: shareWith.map((s) => s.email) } }, "report", "done", `Shared with ${shareWith.length}`, ctx.now()),
          status: "ready_for_review",
        }));
        return { ...doc, sharedWith: shareWith.length };
      },
      summarize: (r) => `report ${(r as { id: string }).id} shared with ${(r as { sharedWith: number }).sharedWith}`,
    },
  ];
}
