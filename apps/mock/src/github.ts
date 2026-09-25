import { MOCK } from "@crisiscrew/contracts";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono, type MiddlewareHandler } from "hono";
import { json, logCalls } from "./freshworks";
import { iso, type Store } from "./store";

const FIXTURE = new URL("../fixtures/checkout-service/", import.meta.url);

/** People on the mock GitHub: the on-call engineer, the payments tech lead (CODEOWNERS), the release's author, and the bot. */
export const GITHUB_USERS = [
  { login: "neha-kapoor", name: "Neha Kapoor", email: "neha.kapoor@example.com", title: "SRE · on call" },
  { login: "kiran-desai", name: "Kiran Desai", email: "kiran.desai@example.com", title: "Payments tech lead" },
  { login: "vikram-s", name: "Vikram Shah", email: "vikram.shah@example.com", title: "Payments engineer" },
  { login: "crisiscrew-bot", name: "CrisisCrew", email: "fix-agent@crisiscrew.dev", title: "Bot" },
];

export type PullRequest = {
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  user: string;
  state: "open" | "closed";
  created_at: string;
  requested_reviewers: string[];
  assignees: string[];
  reviews: { by: string; state: "APPROVED"; at: string }[];
  files: { filename: string; additions: number; deletions: number; patch: string }[];
  commits: { sha: string; message: string; author: string }[];
  checks: { name: string; conclusion: "success" | "failure"; summary: string } | null;
};

const git = (dir: string, args: string[], env: Record<string, string> = {}) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } });

/**
 * The repository the mock hosts: acme-shop/checkout-service, a bare repo
 * with two releases. v4.21.6 is good; v4.21.7 cut the gateway timeout from
 * 15 s to 1.5 s, which is what the incident is about.
 */
export class MockGithub {
  readonly root: string;
  readonly pulls: PullRequest[] = [];
  private next = 1;

  constructor(
    private readonly store: Store,
    private readonly uiOrigin: string,
    root = join(tmpdir(), "crisiscrew-mock", "github"),
  ) {
    this.root = root;
    this.build();
  }

  bare(fullName: string): string {
    return join(this.root, `${fullName}.git`);
  }

  /** (Re)creates the repository from the fixture, with its history; open pull requests are dropped. */
  build(): void {
    rmSync(this.root, { recursive: true, force: true });
    mkdirSync(this.root, { recursive: true });
    const work = join(this.root, "_work");
    cpSync(FIXTURE, work, { recursive: true });
    const as = (name: string, email: string, date: string) => ({ GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
    git(work, ["init", "-q", "-b", "main"]);
    git(work, ["add", "-A"]);
    git(work, ["commit", "-q", "-m", "Show saved UPI handles first"], as("Aditi Rao", "aditi.rao@example.com", new Date(Date.now() - 5 * 3_600_000).toISOString()));
    git(work, ["tag", "v4.21.6"]);
    const config = join(work, "src/config.ts");
    writeFileSync(
      config,
      readFileSync(config, "utf8")
        .replace(" * UPI and 3-D Secure confirmations routinely take 2 to 8 seconds.", " * Fail fast: don't keep customers waiting on a slow gateway.")
        .replace("GATEWAY_TIMEOUT_MS = 15_000", "GATEWAY_TIMEOUT_MS = 1_500"),
    );
    const pkg = join(work, "package.json");
    writeFileSync(pkg, readFileSync(pkg, "utf8").replace('"version": "4.21.6"', '"version": "4.21.7"'));
    git(work, ["commit", "-q", "-am", "perf(checkout): fail fast when the payment gateway is slow"], as("Vikram Shah", "vikram.shah@example.com", new Date(Date.now() - 13 * 60_000).toISOString()));
    git(work, ["tag", "v4.21.7"]);
    mkdirSync(join(this.root, "acme-shop"), { recursive: true });
    git(this.root, ["clone", "-q", "--bare", work, this.bare("acme-shop/checkout-service")]);
    rmSync(work, { recursive: true, force: true });
    this.pulls.length = 0;
    this.next = 1;
  }

  reset(): void {
    this.build();
  }

  private diff(bare: string, base: string, head: string) {
    const numstat = git(bare, ["diff", "--numstat", `${base}...${head}`]).trim();
    return numstat
      ? numstat.split("\n").map((line) => {
          const [add, del, filename] = line.split("\t");
          return { filename: filename!, additions: Number(add) || 0, deletions: Number(del) || 0, patch: git(bare, ["diff", `${base}...${head}`, "--", filename!]).split("\n").slice(4).join("\n") };
        })
      : [];
  }

  private notify(login: string, title: string, body: string, url: string): void {
    const user = GITHUB_USERS.find((u) => u.login === login);
    if (user) this.store.notify({ to: user.email, app: "GitHub", title, body, url });
  }

  prUrl(number: number): string {
    return `${this.uiOrigin}/#/github/pull/${number}`;
  }

  api(): Hono {
    const app = new Hono();
    const auth: MiddlewareHandler = async (c, next) => {
      if (c.req.header("authorization") !== `Bearer ${MOCK.githubToken}`) return c.json({ message: "Bad credentials" }, 401);
      await next();
    };
    app.use("/*", logCalls(this.store, "github"), auth);

    app.get("/repos/:owner/:repo", (c) => {
      const full = `${c.req.param("owner")}/${c.req.param("repo")}`;
      if (!existsSync(this.bare(full))) return c.json({ message: "Not Found" }, 404);
      return c.json({
        name: c.req.param("repo"),
        full_name: full,
        html_url: `${this.uiOrigin}/#/github/repo`,
        clone_url: this.bare(full),
        default_branch: "main",
        description: "Checkout for acme-shop: places orders and takes payment.",
        topics: ["payments", "microservice"],
      });
    });

    app.get("/repos/:owner/:repo/contents/*", (c) => {
      const full = `${c.req.param("owner")}/${c.req.param("repo")}`;
      const path = c.req.path.split("/contents/")[1] ?? "";
      try {
        const content = git(this.bare(full), ["show", `${c.req.query("ref") ?? "main"}:${decodeURIComponent(path)}`]);
        return c.json({ path, encoding: "base64", content: Buffer.from(content).toString("base64") });
      } catch {
        return c.json({ message: "Not Found" }, 404);
      }
    });

    app.get("/repos/:owner/:repo/compare/:spec", (c) => {
      const full = `${c.req.param("owner")}/${c.req.param("repo")}`;
      const [base, head] = decodeURIComponent(c.req.param("spec")).split("...");
      try {
        return c.json({ files: this.diff(this.bare(full), base!, head!) });
      } catch {
        return c.json({ message: "No common ancestor" }, 404);
      }
    });

    app.get("/search/users", (c) => {
      const q = (c.req.query("q") ?? "").toLowerCase();
      const items = GITHUB_USERS.filter((u) => q.includes(u.email.toLowerCase()) || q.includes(u.login)).map((u) => ({ login: u.login }));
      return c.json({ total_count: items.length, items });
    });

    app.get("/users/:login", (c) => {
      const user = GITHUB_USERS.find((u) => u.login === c.req.param("login"));
      return user ? c.json({ login: user.login, name: user.name, email: user.email }) : c.json({ message: "Not Found" }, 404);
    });

    app.post("/repos/:owner/:repo/pulls", async (c) => {
      const full = `${c.req.param("owner")}/${c.req.param("repo")}`;
      const body = await json(c);
      const head = typeof body?.head === "string" ? body.head : "";
      const base = typeof body?.base === "string" ? body.base : "main";
      try {
        git(this.bare(full), ["rev-parse", "--verify", `refs/heads/${head}`]);
      } catch {
        return c.json({ message: "Validation Failed", errors: [{ field: "head", code: "invalid" }] }, 422);
      }
      const commits = git(this.bare(full), ["log", `${base}..${head}`, "--format=%h%x09%s%x09%an"]).trim().split("\n").filter(Boolean).map((l) => {
        const [sha, message, author] = l.split("\t");
        return { sha: sha!, message: message!, author: author! };
      });
      const pr: PullRequest = {
        number: this.next++,
        title: typeof body?.title === "string" ? body.title : head,
        body: typeof body?.body === "string" ? body.body : "",
        head,
        base,
        user: "crisiscrew-bot",
        state: "open",
        created_at: iso(),
        requested_reviewers: [],
        assignees: [],
        reviews: [],
        files: this.diff(this.bare(full), base, head),
        commits,
        checks: null,
      };
      this.pulls.push(pr);
      this.store.touch();
      this.runChecks(full, pr);
      return c.json({ number: pr.number, html_url: this.prUrl(pr.number), state: pr.state, title: pr.title }, 201);
    });

    app.post("/repos/:owner/:repo/pulls/:n/requested_reviewers", async (c) => {
      const pr = this.pulls.find((p) => p.number === Number(c.req.param("n")));
      if (!pr) return c.json({ message: "Not Found" }, 404);
      const reviewers = ((await json(c))?.reviewers as string[] | undefined) ?? [];
      pr.requested_reviewers = [...new Set([...pr.requested_reviewers, ...reviewers])];
      for (const r of reviewers) this.notify(r, `Review requested: #${pr.number}`, pr.title, this.prUrl(pr.number));
      this.store.touch();
      return c.json({ number: pr.number, requested_reviewers: pr.requested_reviewers.map((login) => ({ login })) }, 201);
    });

    app.post("/repos/:owner/:repo/issues/:n/assignees", async (c) => {
      const pr = this.pulls.find((p) => p.number === Number(c.req.param("n")));
      if (!pr) return c.json({ message: "Not Found" }, 404);
      const assignees = ((await json(c))?.assignees as string[] | undefined) ?? [];
      pr.assignees = [...new Set([...pr.assignees, ...assignees])];
      for (const a of assignees) this.notify(a, `You were assigned #${pr.number}`, pr.title, this.prUrl(pr.number));
      this.store.touch();
      return c.json({ number: pr.number, assignees: pr.assignees.map((login) => ({ login })) }, 201);
    });

    app.get("/repos/:owner/:repo/pulls/:n", (c) => {
      const pr = this.pulls.find((p) => p.number === Number(c.req.param("n")));
      return pr ? c.json({ ...pr, html_url: this.prUrl(pr.number) }) : c.json({ message: "Not Found" }, 404);
    });

    return app;
  }

  /** The repository's CI on the pull request: the tests, run on a fresh checkout of the branch. */
  private runChecks(full: string, pr: PullRequest): void {
    const dir = join(this.root, `_ci-${pr.number}`);
    try {
      rmSync(dir, { recursive: true, force: true });
      git(this.root, ["clone", "-q", "--branch", pr.head, this.bare(full), dir]);
      let output = "";
      let ok = true;
      try {
        output = execFileSync("npm", ["test"], { cwd: dir, encoding: "utf8", env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" }, stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        ok = false;
        output = String((error as { stdout?: string }).stdout ?? error);
      }
      const pass = /ℹ pass (\d+)/.exec(output)?.[1] ?? "0";
      const fail = /ℹ fail (\d+)/.exec(output)?.[1] ?? "0";
      pr.checks = { name: "CI / npm test", conclusion: ok ? "success" : "failure", summary: `${pass} passed, ${fail} failed` };
    } catch (error) {
      pr.checks = { name: "CI / npm test", conclusion: "failure", summary: error instanceof Error ? error.message.slice(0, 120) : "CI failed" };
    } finally {
      rmSync(dir, { recursive: true, force: true });
      this.store.touch();
    }
  }

  approve(number: number, by: string): PullRequest | null {
    const pr = this.pulls.find((p) => p.number === number);
    if (!pr) return null;
    if (!pr.reviews.some((r) => r.by === by)) pr.reviews.push({ by, state: "APPROVED", at: iso() });
    this.store.touch();
    return pr;
  }
}
