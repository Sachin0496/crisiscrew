import { describe, expect, it } from "vitest";
import { scanPatch, SECURITY_RULES } from "./security";

const diff = (file: string, lines: string[], from = file) =>
  [`diff --git a/${from} b/${file}`, `--- a/${from}`, `+++ b/${file}`, `@@ -1,2 +1,${lines.length} @@`, ...lines].join("\n");

describe("the fix's security checks", () => {
  it("finds nothing in a clean fix, and counts what it read", () => {
    const patch = diff("src/config.ts", ["-export const GATEWAY_TIMEOUT_MS = 1_500;", "+export const GATEWAY_TIMEOUT_MS = 15_000;", " export const RETRIES = 2;"]);
    expect(scanPatch(patch)).toEqual({ findings: [], files: 1, addedLines: 1 });
    expect(SECURITY_RULES).toBeGreaterThanOrEqual(8);
  });

  it("blocks secrets, disabled TLS and runtime code, with the line they're on", () => {
    const patch = diff("src/payments/gateway.ts", [" const a = 1;", '+const apiKey = "sk_live_51HxQ2mZ";', "+const agent = new Agent({ rejectUnauthorized: false });", "+eval(body);"]);
    const { findings } = scanPatch(patch);
    expect(findings.map((f) => [f.severity, f.rule, f.line])).toEqual([
      ["P1", "secret", 2],
      ["P1", "tls-off", 3],
      ["P1", "code-exec", 4],
    ]);
    expect(findings.every((f) => f.file === "src/payments/gateway.ts")).toBe(true);
  });

  it("flags CI, CODEOWNERS and dependency changes by file, and removed tests", () => {
    const patch = [
      diff(".github/workflows/deploy.yml", ["+    run: ./deploy.sh"]),
      diff(".github/CODEOWNERS", ["+* @someone"]),
      diff("package.json", ['+    "left-pad": "1.3.0",']),
      diff("test/checkout.test.ts", ['-it("a declined card fails the order", () => {', "+// removed"]),
    ].join("\n");
    expect(scanPatch(patch).findings.map((f) => `${f.severity} ${f.rule} ${f.file}`)).toEqual([
      "P1 ci-config .github/workflows/deploy.yml",
      "P1 codeowners .github/CODEOWNERS",
      "P3 dependency package.json",
      "P2 test-removed test/checkout.test.ts",
    ]);
  });

  it("ignores what the fix removes, except tests", () => {
    expect(scanPatch(diff("src/a.ts", ['-const password = "hunter2hunter2";', "+const password = process.env.DB_PASSWORD;"])).findings).toEqual([]);
  });
});
