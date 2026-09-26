import type { RepoInfo, TestRun, WorkspacePort } from "@crisiscrew/core";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** Runs a shell command in a directory; output is stdout and stderr together. Never throws for a failing command. */
export function runCommand(dir: string, command: string, timeoutMs = 60_000): Promise<{ code: number; output: string; durationMs: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], { cwd: dir, env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", CI: "1", GIT_TERMINAL_PROMPT: "0" } });
    let output = "";
    const take = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > 200_000) output = output.slice(-100_000);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output, durationMs: Date.now() - started });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 1, output: `${output}${error.message}`, durationMs: Date.now() - started });
    });
  });
}

/**
 * Pass and fail counts from a test runner's output: Node's (ℹ pass 4 · ℹ fail 0),
 * Vitest and Jest (Tests  2 failed | 4 passed), or Mocha (4 passing · 2 failing).
 */
export function testCounts(output: string): { passed: number; failed: number } {
  const num = (re: RegExp) => Number(re.exec(output)?.[1] ?? 0);
  if (/ℹ pass \d+/.test(output) || /^# pass \d+/m.test(output)) return { passed: num(/(?:ℹ|#) pass (\d+)/), failed: num(/(?:ℹ|#) fail (\d+)/) };
  if (/Tests?:?\s+.*(passed|failed)/.test(output)) return { passed: num(/(\d+) passed/), failed: num(/(\d+) failed/) };
  return { passed: num(/(\d+) passing/), failed: num(/(\d+) failing/) };
}

export async function runTests(dir: string, command: string): Promise<TestRun> {
  const run = await runCommand(dir, command, 120_000);
  const { passed, failed } = testCounts(run.output);
  return { command, passed, failed, ok: run.code === 0 && failed === 0, output: run.output, durationMs: run.durationMs };
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Scratch checkouts with git: a fresh clone per fix, on a branch of its own.
 * Commits carry the Fix Agent's identity; only that branch is ever pushed.
 */
export function gitWorkspace(options: { root: string; author: { name: string; email: string } }): WorkspacePort {
  const git = async (dir: string, args: string) => {
    const r = await runCommand(dir, `git ${args}`);
    if (r.code !== 0) throw new Error(`git ${args.split(" ")[0]} failed: ${r.output.trim().slice(-300)}`);
    return r.output;
  };
  return {
    mode: "live",
    adapter: "git",
    async checkout(repo: RepoInfo, branch: string) {
      mkdirSync(options.root, { recursive: true });
      const dir = join(options.root, `${repo.fullName.replace(/\W+/g, "-")}-${Date.now().toString(36)}`);
      await git(options.root, `clone --quiet ${q(repo.cloneUrl)} ${q(dir)}`);
      await git(dir, `checkout --quiet -b ${q(branch)}`);
      await git(dir, `config user.name ${q(options.author.name)}`);
      await git(dir, `config user.email ${q(options.author.email)}`);
      return { dir };
    },
    test: runTests,
    async diff(dir) {
      // Intent-to-add, so new files show in the diff without staging their content.
      await git(dir, "add -A -N");
      return git(dir, "diff");
    },
    async commitAndPush(dir, branch, message) {
      await git(dir, "add -A");
      await git(dir, `commit --quiet -m ${q(message)}`);
      const sha = (await git(dir, "rev-parse HEAD")).trim();
      const numstat = await git(dir, "diff --numstat HEAD~1 HEAD");
      const patch = await git(dir, "diff HEAD~1 HEAD");
      await git(dir, `push --quiet origin ${q(branch)}`);
      const files = numstat
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [add, del, path] = line.split("\t");
          return { path: path ?? "", additions: Number(add) || 0, deletions: Number(del) || 0 };
        });
      return { sha, files, patch };
    },
  };
}
