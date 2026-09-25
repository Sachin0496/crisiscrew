import { githubCodeHost, gitWorkspace, googleDocs, replayCodingAgent, teamKnowledge, testCounts, type ReplaySession } from "@crisiscrew/adapters";
import { MOCK, mockPorts } from "@crisiscrew/contracts";
import type { CodingEvent } from "@crisiscrew/core";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createMock } from "./app";
import { paragraphs } from "./google";

const ports = mockPorts();
const root = mkdtempSync(join(tmpdir(), "crisiscrew-autofix-test-"));
let mock: ReturnType<typeof createMock>;
const net = (async (input: RequestInfo | URL | string, init?: RequestInit) => {
  const req = new Request(input as string, init);
  const port = Number(new URL(req.url).port);
  const app = { [ports.github]: mock.apps.github, [ports.google]: mock.apps.google, [ports.slack]: mock.apps.slack }[port];
  if (!app) throw new Error(`nothing listens at ${req.url}`);
  return app.fetch(req);
}) as typeof fetch;
mock = createMock({ crisiscrewUrl: "http://crisis.test", uiOrigin: "http://localhost:8788", fetch: net, githubRoot: join(root, "github") });

const github = githubCodeHost({ apiBase: `http://localhost:${ports.github}`, token: MOCK.githubToken, repos: MOCK.repos, fetch: net });
const session = JSON.parse(readFileSync(new URL("../fixtures/checkout-service.opencode.json", import.meta.url), "utf8")) as ReplaySession;

afterAll(() => {
  mock.stop();
  rmSync(root, { recursive: true, force: true });
});

describe("the Fix Agent's adapters against the mocks", () => {
  it("finds the service's repository, its code owners and what the release changed", async () => {
    const repo = (await github.repoFor("checkout-service"))!;
    expect(repo).toMatchObject({ fullName: "acme-shop/checkout-service", defaultBranch: "main", architecture: "microservice", owners: ["kiran-desai"] });
    const diff = await github.compare(repo, "v4.21.6", "v4.21.7");
    expect(diff.files.map((f) => f.path)).toEqual(["package.json", "src/config.ts"]);
    expect(diff.files[1]!.patch).toContain("+export const GATEWAY_TIMEOUT_MS = 1_500;");
    expect(await github.userByEmail("neha.kapoor@example.com")).toMatchObject({ login: "neha-kapoor", name: "Neha Kapoor" });
    expect(await github.repoFor("search-service")).toBeNull();
  });

  it("replays OpenCode on a real clone: the new test fails first, the patched code passes, and the PR carries the real diff", async () => {
    const repo = (await github.repoFor("checkout-service"))!;
    const workspace = gitWorkspace({ root: join(root, "work"), author: { name: "CrisisCrew Fix Agent", email: "fix-agent@crisiscrew.dev" } });
    const { dir } = await workspace.checkout(repo, "crisiscrew/inc-test-fix");
    const coding = replayCodingAgent({ session, pace: 0 });
    const events: CodingEvent[] = [];
    const done = new Promise<void>((resolve) => coding.onEvent((_, e) => { events.push(e); if (e.type === "done" || e.type === "failed") resolve(); }));
    await coding.start({ dir, prompt: "fix it", testCommand: repo.testCommand });
    await done;
    const tests = events.filter((e): e is Extract<CodingEvent, { type: "tests" }> => e.type === "tests");
    expect(tests.map((t) => [t.phase, t.run.passed, t.run.failed, t.run.ok])).toEqual([["before", 2, 2, false], ["after", 4, 0, true]]);
    expect(events.find((e) => e.type === "text" && e.diagnosis)).toBeTruthy();
    expect(events.at(-1)).toMatchObject({ type: "done" });

    const verified = await workspace.test(dir, repo.testCommand);
    expect(verified).toMatchObject({ passed: 4, failed: 0, ok: true });
    const pushed = await workspace.commitAndPush(dir, "crisiscrew/inc-test-fix", "fix(checkout): restore the gateway timeout");
    expect(pushed.files.map((f) => f.path).sort()).toEqual(["src/config.ts", "src/orders/checkout.ts", "test/gateway-timeout.test.ts"]);

    const pr = await github.openPullRequest(repo, { branch: "crisiscrew/inc-test-fix", title: "fix(checkout): restore the gateway timeout", body: "Fixes INC-TEST", reviewers: ["kiran-desai"], assignees: ["neha-kapoor"] });
    expect(pr.number).toBe(1);
    const stored = mock.github.pulls[0]!;
    expect(stored).toMatchObject({ requested_reviewers: ["kiran-desai"], assignees: ["neha-kapoor"], checks: { conclusion: "success", summary: "4 passed, 0 failed" } });
    expect(stored.files.find((f) => f.filename === "src/config.ts")!.patch).toContain("+export const GATEWAY_TIMEOUT_MS = 15_000;");
    expect(mock.store.notifications.map((n) => [n.to, n.app, n.title])).toEqual([
      ["kiran.desai@example.com", "GitHub", "Review requested: #1"],
      ["neha.kapoor@example.com", "GitHub", "You were assigned #1"],
    ]);
  }, 60_000);

  it("writes the report in Google Docs, shares it (Google notifies each person), and finds runbooks and Slack threads", async () => {
    const docs = googleDocs({ docsBase: `http://localhost:${ports.google}`, driveBase: `http://localhost:${ports.google}`, token: MOCK.googleToken, viewBase: "http://localhost:8788/#/docs/", fetch: net });
    const published = await docs.publish({
      title: "INC-1 report",
      blocks: [{ kind: "heading", text: "Summary" }, { kind: "paragraph", text: "It broke." }, { kind: "bullets", items: ["one", "two"] }, { kind: "link", text: "PR #1", url: "http://x/pr/1" }],
      shareWith: [{ email: "neha.kapoor@example.com", role: "writer" }],
      message: "It's yours.",
    });
    expect(published.url).toBe(`http://localhost:8788/#/docs/${published.id}`);
    const doc = mock.docs.find((d) => d.id === published.id)!;
    expect(paragraphs(doc).map((p) => [p.style, p.bullet, p.text, p.link ?? null])).toEqual([
      ["TITLE", false, "INC-1 report", null],
      ["HEADING_1", false, "Summary", null],
      ["NORMAL_TEXT", false, "It broke.", null],
      ["NORMAL_TEXT", true, "one", null],
      ["NORMAL_TEXT", true, "two", null],
      ["NORMAL_TEXT", false, "PR #1", "http://x/pr/1"],
    ]);
    expect(mock.store.notifications.at(-1)).toMatchObject({ to: "neha.kapoor@example.com", app: "Google Docs", body: "It's yours." });

    const knowledge = teamKnowledge({ slack: { apiBase: `http://localhost:${ports.slack}`, token: MOCK.slackToken }, drive: { apiBase: `http://localhost:${ports.google}`, token: MOCK.googleToken }, fetch: net });
    const hits = await knowledge.search("gateway timeout");
    expect(hits.map((h) => h.source)).toEqual(["slack", "slack", "runbook", "runbook"]);
    expect(hits[0]!.snippet).toContain("cut the gateway timeout to 1.5 s");
  });
});

describe("testCounts", () => {
  it("reads Node, Vitest and Mocha summaries", () => {
    expect(testCounts("ℹ tests 4\nℹ pass 2\nℹ fail 2")).toEqual({ passed: 2, failed: 2 });
    expect(testCounts(" Tests  1 failed | 5 passed (6)")).toEqual({ passed: 5, failed: 1 });
    expect(testCounts("  3 passing (20ms)\n  1 failing")).toEqual({ passed: 3, failed: 1 });
  });
});
