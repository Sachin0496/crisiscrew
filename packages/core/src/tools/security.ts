import type { FixFinding } from "@crisiscrew/contracts";

/**
 * Deterministic security checks on a fix's diff, before it goes to review.
 * Only the lines the coding agent added are read, and no model is involved:
 * the same diff always gives the same findings. P1 blocks the pull request;
 * P2 and P3 are listed in it for the reviewer.
 */

type Rule = { id: string; severity: FixFinding["severity"]; text: string; line?: RegExp; file?: RegExp; deleted?: RegExp };

const RULES: Rule[] = [
  { id: "secret", severity: "P1", text: "Looks like a hard-coded secret", line: /(AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|\b(api[_-]?key|secret|password|passwd|token)\b\s*[:=]\s*["'][^"'\s]{8,}["'])/i },
  { id: "tls-off", severity: "P1", text: "Turns off TLS certificate checks", line: /(rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED|InsecureSkipVerify\s*:\s*true|verify\s*=\s*False)/ },
  { id: "code-exec", severity: "P1", text: "Runs code built at runtime", line: /(\beval\s*\(|new\s+Function\s*\(|child_process|\bexecSync\s*\(|\bexec\s*\(\s*`)/ },
  { id: "sql-concat", severity: "P2", text: "SQL built by string concatenation", line: /\b(SELECT|INSERT|UPDATE|DELETE)\b[^;]*["'`]\s*\+|\$\{[^}]+\}[^`]*\b(WHERE|VALUES)\b/i },
  { id: "ci-config", severity: "P1", text: "Changes CI or deploy configuration", file: /^(\.github\/workflows\/|\.gitlab-ci\.yml$|Jenkinsfile$|deploy\/|\.circleci\/)/ },
  { id: "codeowners", severity: "P1", text: "Changes who must review the code", file: /(^|\/)CODEOWNERS$/ },
  { id: "dependency", severity: "P3", text: "Adds or changes a dependency", file: /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|go\.sum|requirements\.txt|Cargo\.lock)$/ },
  { id: "test-removed", severity: "P2", text: "Removes a test", deleted: /^\s*(it|test|describe)\s*\(/ },
];

/** How many checks run on every fix. */
export const SECURITY_RULES = RULES.length;

/** The findings for a unified diff (git diff output). */
export function scanPatch(patch: string): { findings: FixFinding[]; files: number; addedLines: number } {
  const findings: FixFinding[] = [];
  const seen = new Set<string>();
  const add = (f: FixFinding) => {
    const key = `${f.rule}:${f.file}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(f);
  };
  let file = "";
  let line = 0;
  let files = 0;
  let addedLines = 0;
  for (const raw of patch.split("\n")) {
    const header = /^\+\+\+ (?:b\/)?(.+)$/.exec(raw);
    if (header) {
      file = header[1] === "/dev/null" ? file : header[1]!;
      files += 1;
      for (const rule of RULES) if (rule.file?.test(file)) add({ severity: rule.severity, rule: rule.id, file, text: rule.text });
      continue;
    }
    if (raw.startsWith("--- ")) {
      const from = /^--- (?:a\/)?(.+)$/.exec(raw)?.[1];
      if (from && from !== "/dev/null") file = from;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("+")) {
      addedLines += 1;
      const text = raw.slice(1);
      for (const rule of RULES) if (rule.line?.test(text)) add({ severity: rule.severity, rule: rule.id, file, line, text: rule.text });
      line += 1;
    } else if (raw.startsWith("-")) {
      for (const rule of RULES) if (rule.deleted?.test(raw.slice(1))) add({ severity: rule.severity, rule: rule.id, file, text: rule.text });
    } else if (!raw.startsWith("\\")) {
      line += 1;
    }
  }
  return { findings, files, addedLines };
}
