import type { CodingAgentPort, CodingEvent } from "@crisiscrew/core";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { runCommand, runTests } from "./workspace";

/**
 * A recorded coding-agent session, replayed against a real workspace: the
 * model's words are recorded, but every read, write and edit happens on the
 * files, and every command (the tests included) really runs. So the diff is
 * real, and so are the red and green test runs. Used in mock mode instead of
 * starting OpenCode against a model.
 */
export type ReplayStep = { delayMs?: number } & (
  | { type: "text"; text: string; diagnosis?: boolean }
  | { type: "read"; path: string }
  | { type: "grep"; pattern: string }
  | { type: "bash"; command: string; tests?: "before" | "after" }
  | { type: "write"; path: string; content: string }
  | { type: "edit"; path: string; find: string; replace: string }
);

export type ReplaySession = { tool: string; model: string; title: string; summary: string; steps: ReplayStep[] };

const tail = (text: string, lines = 14) => text.trimEnd().split("\n").slice(-lines).join("\n");
const head = (text: string, lines = 14) => text.split("\n").slice(0, lines).join("\n");

/** A mini unified diff for one edit. */
function hunk(find: string, replace: string): string {
  return [...find.split("\n").map((l) => `-${l}`), ...replace.split("\n").map((l) => `+${l}`)].join("\n");
}

export function replayCodingAgent(options: { session: ReplaySession; pace?: number }): CodingAgentPort {
  const listeners = new Set<(sessionId: string, event: CodingEvent) => void>();
  const pace = options.pace ?? 1;
  const emit = (id: string, event: CodingEvent) => {
    for (const l of listeners) l(id, event);
  };
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms * pace));

  async function play(id: string, dir: string, testCommand: string): Promise<void> {
    for (const step of options.session.steps) {
      await wait(step.delayMs ?? 900);
      switch (step.type) {
        case "text":
          emit(id, { type: "text", text: step.text, ...(step.diagnosis ? { diagnosis: true } : {}) });
          break;
        case "read": {
          const content = readFileSync(join(dir, step.path), "utf8");
          emit(id, { type: "tool", tool: "read", title: step.path, detail: `${content.split("\n").length} lines\n${head(content)}`, ok: true });
          break;
        }
        case "grep": {
          const r = await runCommand(dir, `git grep -n ${JSON.stringify(step.pattern)}`);
          emit(id, { type: "tool", tool: "grep", title: step.pattern, detail: tail(r.output, 8), ok: r.code === 0 });
          break;
        }
        case "write":
          mkdirSync(dirname(join(dir, step.path)), { recursive: true });
          writeFileSync(join(dir, step.path), step.content);
          emit(id, { type: "tool", tool: "write", title: step.path, detail: step.content.split("\n").map((l) => `+${l}`).slice(0, 40).join("\n"), ok: true });
          break;
        case "edit": {
          const file = join(dir, step.path);
          const before = readFileSync(file, "utf8");
          if (!before.includes(step.find)) {
            emit(id, { type: "failed", reason: `edit of ${step.path} didn't apply: the code isn't what the session expected` });
            return;
          }
          writeFileSync(file, before.replace(step.find, step.replace));
          emit(id, { type: "tool", tool: "edit", title: step.path, detail: hunk(step.find, step.replace), ok: true });
          break;
        }
        case "bash": {
          if (step.tests) {
            const run = await runTests(dir, step.command === "test" ? testCommand : step.command);
            emit(id, { type: "tool", tool: "bash", title: `$ ${run.command}`, detail: tail(run.output, 16), ok: run.ok });
            emit(id, { type: "tests", phase: step.tests, run });
          } else {
            const r = await runCommand(dir, step.command);
            emit(id, { type: "tool", tool: "bash", title: `$ ${step.command}`, detail: tail(r.output, 16), ok: r.code === 0 });
          }
          break;
        }
      }
    }
    await wait(700);
    emit(id, { type: "done", summary: options.session.summary, title: options.session.title });
  }

  return {
    mode: "live",
    adapter: "opencode-replay",
    tool: options.session.tool,
    model: options.session.model,
    async start({ dir, testCommand }) {
      const sessionId = `ses_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      void play(sessionId, dir, testCommand).catch((error) => emit(sessionId, { type: "failed", reason: error instanceof Error ? error.message : String(error) }));
      return { sessionId };
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
