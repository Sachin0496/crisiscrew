import { initialState, type CrisisState, type FixView, type IncidentView } from "@crisiscrew/contracts";
import { describe, expect, it } from "vitest";
import { newFix, summarizeChange } from "../tools/fix";
import { pageDialog } from "./dialog";

const incident = {
  id: "INC-2026-001",
  status: "recovering",
  severity: "high",
  surface: "checkout_payments",
  openedAt: 0,
  clusterId: "c1",
  ticketIds: ["T-1", "T-2"],
  linkedTicketIds: [],
  hypotheses: [{ id: "h1", kind: "deploy", subject: "checkout-service@4.21.7", label: "checkout-service v4.21.7", prior: 0.4, evidence: [], score: 1, confidence: 0.97 }],
  rootCause: { hypothesisId: "h1", label: "checkout-service v4.21.7", confidence: 0.97 },
  impact: {
    since: 0,
    assessedAt: 0,
    customers: [
      { ref: "a", name: "A", tier: "standard", consent: { proactive: true, voice: false }, complained: true, ticketIds: ["T-1"], confidence: "confirmed", severity: "medium", failedAttempts: 1, amountInr: 1000, evidence: [] },
      { ref: "b", name: "B", tier: "standard", consent: { proactive: true, voice: false }, complained: false, ticketIds: [], confidence: "confirmed", severity: "medium", failedAttempts: 1, amountInr: 500, evidence: [] },
    ],
  },
  actions: [],
  updates: [],
  timeline: [],
  engineering: { id: "#301", adapter: "freshservice", change: { id: "CHN-21" } },
} as unknown as IncidentView;

function state(fix?: Partial<FixView>): CrisisState {
  const s = initialState();
  return { ...s, incidents: { [incident.id]: incident }, fixes: fix ? { [incident.id]: { ...newFix(incident.id, "checkout-service", 0), ...fix } } : {} };
}

describe("summarizeChange", () => {
  it("says what the release changed in code, skipping version bumps", () => {
    const files = [
      { path: "package.json", patch: '-  "version": "4.21.6",\n+  "version": "4.21.7",' },
      { path: "src/config.ts", patch: " /**\n- * UPI takes seconds.\n+ * Fail fast.\n */\n-export const GATEWAY_TIMEOUT_MS = 15_000;\n+export const GATEWAY_TIMEOUT_MS = 1_500;" },
    ];
    expect(summarizeChange(files)).toEqual({ sentence: "The release changed GATEWAY_TIMEOUT_MS in src/config.ts from 15_000 to 1_500.", keywords: ["gateway", "timeout"] });
  });
});

describe("pageDialog", () => {
  it("takes the acknowledgement and answers what changed from the fix's diagnosis", () => {
    const dialog = pageDialog(() => state({ diagnosis: "v4.21.7 cut the gateway timeout from 15 seconds to 1.5." }), incident.id, "Neha Kapoor");
    const turn = dialog.respond("Acknowledged, I'm on it. What changed in that release?");
    expect(turn.acknowledge).toBe(true);
    expect(turn.say).toBe("Thanks Neha, INC 2026 001 is yours. The likely cause is checkout-service v4.21.7, at 97 percent confidence. v4.21.7 cut the gateway timeout from 15 seconds to 1.5.");
    // Only once: the next turn doesn't acknowledge again.
    expect(dialog.respond("Acknowledge").acknowledge).toBeUndefined();
  });

  it("tells the engineer where the fix is, live", () => {
    const running = state({ repo: { fullName: "acme-shop/checkout-service", url: "", defaultBranch: "main", architecture: "microservice" }, branch: "crisiscrew/inc-2026-001-fix", agent: { tool: "opencode", model: "m" }, tests: { before: { command: "npm test", passed: 2, failed: 2, ok: false, output: "", at: 0 } }, people: { reviewers: [{ name: "Kiran Desai", login: "kiran-desai" }] } });
    running.fixes[incident.id]!.stages.patch = { status: "running" };
    const say = pageDialog(() => running, incident.id, "Neha Kapoor").respond("Do I need to roll back, or start writing a fix?").say;
    expect(say).toContain("You don't need to write the fix.");
    expect(say).toContain("OpenCode reproduced the bug with 2 failing tests and is patching it now.");
    expect(say).toContain("with Kiran Desai as reviewer");
    expect(say).toContain("A rollback change, CHN-21, is also filed");
  });

  it("answers questions about the coding agent while it works, and keeps the call going after the acknowledgement", () => {
    const working = state({
      status: "running",
      repo: { fullName: "acme-shop/checkout-service", url: "", defaultBranch: "main", architecture: "microservice" },
      agent: { tool: "opencode", model: "m" },
      diagnosis: "v4.21.7 cut the gateway timeout from 15 seconds to 1.5.",
      session: [{ at: 0, kind: "tool", tool: "edit", title: "Edited src/gateway.ts" }],
      tests: { before: { command: "npm test", passed: 2, failed: 2, ok: false, output: "", at: 0 }, after: { command: "npm test", passed: 4, failed: 0, ok: true, output: "", at: 0 } },
      diff: { files: [{ path: "src/gateway.ts", additions: 3, deletions: 1 }], patch: "", sha: "abc" },
      people: { reviewers: [{ name: "Kiran Desai", login: "kiran-desai" }] },
    });
    const dialog = pageDialog(() => working, incident.id, "Neha Kapoor");
    const ack = dialog.respond("Acknowledge");
    expect(ack).toMatchObject({ acknowledge: true });
    expect(ack.end).toBeUndefined();
    expect(ack.say).toContain("The Fix Agent is already working on the code");
    expect(dialog.respond("What is the coding agent doing right now?").say).toContain("Its latest step: Edited src/gateway.ts.");
    expect(dialog.respond("Are the tests passing?").say).toBe("OpenCode wrote a test that reproduces the bug: 2 failing before the patch. After its patch, 4 pass and 0 fail.");
    expect(dialog.respond("Which files did it change?").say).toContain("The patch touches 1 file: gateway.ts, plus 3 minus 1.");
    expect(dialog.respond("Who is reviewing the PR?").say).toContain("with Kiran Desai as reviewer. Nothing merges without a human.");
    expect(dialog.respond("How long will it take?").say).toMatch(/^About \d+ minutes?:/);
    expect(dialog.respond("Is it secure?").say).toContain("deterministic rules");
    // Coding-agent questions and unknown ones are open, for a voice that can reason; the facts carry the fix's live state.
    expect(dialog.respond("Which branch is it on?")).toMatchObject({ open: true });
    expect(dialog.respond("How many customers are hit?").open).toBeUndefined();
    const facts = dialog.facts!();
    expect(facts).toContain("Diff: src/gateway.ts +3 -1");
    expect(facts).toContain("Tests after the patch: 4 passed, 0 failed.");
    expect(facts).toContain("[edit] Edited src/gateway.ts");
    expect(facts).toContain("area checkout payments");
  });

  it("answers the impact, and hangs up on thanks", () => {
    const dialog = pageDialog(() => state(), incident.id, "Neha Kapoor");
    expect(dialog.respond("How many customers are hit?").say).toContain("2 customers are confirmed affected, 1,500 rupees");
    expect(dialog.respond("Perfect, thanks. I'll review it now.")).toMatchObject({ end: true });
  });
});
