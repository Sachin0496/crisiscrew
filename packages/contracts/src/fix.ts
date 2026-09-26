/**
 * The Fix Agent's work on one incident: it gathers context, clones the
 * service's repository, lets a headless coding agent (OpenCode) reproduce
 * and patch the bug, verifies the tests itself, opens a pull request for a
 * human to review once deterministic security checks pass, and shares an
 * incident report. It never merges or deploys.
 */

/** The steps of a fix, in order. */
export const FIX_STAGES = ["context", "workspace", "reproduce", "patch", "verify", "security", "pull_request", "report"] as const;
export type FixStage = (typeof FIX_STAGES)[number];
export type FixStepStatus = "pending" | "running" | "done" | "failed" | "skipped";

/** One piece of context the Fix Agent read before touching code. */
export type FixSource = {
  kind: "tickets" | "engineering" | "release" | "metrics" | "slack" | "runbook" | "architecture";
  title: string;
  detail: string;
  url?: string;
};

/** One event of the coding agent's session: a thought, a tool call (read, edit, bash…) or its output. */
export type FixSessionEvent = {
  at: number;
  kind: "text" | "tool";
  /** For a tool call: read, write, edit, bash, grep. */
  tool?: string;
  title: string;
  /** Output, a diff hunk, or the thought itself; clipped. */
  detail?: string;
  ok?: boolean;
};

/** One finding of the security checks on the fix's diff. P1 blocks the pull request. */
export type FixFinding = { severity: "P1" | "P2" | "P3"; rule: string; file: string; line?: number; text: string };

/** Deterministic security checks on the lines the coding agent added: no model in the loop. */
export type FixSecurity = { findings: FixFinding[]; files: number; addedLines: number; rules: number; ok: boolean; at: number };

/** One run of the repository's tests. */
export type FixTestRun = { command: string; passed: number; failed: number; ok: boolean; output: string; at: number };

export type FixView = {
  incidentId: string;
  status: "running" | "ready_for_review" | "failed" | "skipped";
  startedAt: number;
  updatedAt: number;
  service: string;
  repo?: { fullName: string; url: string; defaultBranch: string; architecture: "microservice" | "monolith" };
  branch?: string;
  stages: Record<FixStage, { status: FixStepStatus; detail?: string; at?: number }>;
  context: FixSource[];
  /** What changed in the blamed release, in one sentence (from its diff). */
  releaseChange?: string;
  /** The coding agent's diagnosis, once it has one. */
  diagnosis?: string;
  agent?: { tool: string; model: string; sessionId?: string };
  session: FixSessionEvent[];
  tests: { before?: FixTestRun; after?: FixTestRun; verified?: FixTestRun };
  security?: FixSecurity;
  diff?: { files: { path: string; additions: number; deletions: number }[]; patch: string; sha: string };
  pullRequest?: { number: number; url: string; title: string; reviewers: string[]; assignees: string[] };
  report?: { id: string; url: string; title: string; sharedWith: string[] };
  /** The people the fix is for: the engineer who reviews it, and whoever the repository's owners require. */
  people?: { oncall?: { name: string; email?: string; login?: string }; reviewers: { name: string; login: string; email?: string }[] };
  /** The task the coding agent was given, word for word. */
  prompt?: string;
  testCommand?: string;
  /** The scratch checkout the coding agent works in. */
  workdir?: string;
  /** The pull request's title, as the coding agent proposed it. */
  title?: string;
  error?: string;
};

export const FIX_SESSION_CAP = 120;
