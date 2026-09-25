// Runs the mock services and CrisisCrew (INTEGRATIONS=mock) together, and stops both on Ctrl+C.
// Usage: pnpm demo:mock   (build the UI first with `pnpm build`, which demo:mock does)
import { spawn } from "node:child_process";

const run = (name, args, env = {}) => {
  const child = spawn("pnpm", args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      for (const line of chunk.toString().split("\n")) if (line.trim()) process.stdout.write(`[${name}] ${line}\n`);
    });
  }
  child.on("exit", (code) => {
    console.log(`[${name}] exited${code ? ` with ${code}` : ""}`);
    stop(code ?? 0);
  });
  return child;
};

const children = [
  run("mock", ["--filter", "@crisiscrew/mock", "start"]),
  run("crisiscrew", ["--filter", "@crisiscrew/server", "start"], { INTEGRATIONS: "mock" }),
];

let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 300);
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop(0));
