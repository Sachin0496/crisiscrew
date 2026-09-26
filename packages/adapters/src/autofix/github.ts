import type { CodeHostPort, CodeUser, RepoInfo } from "@crisiscrew/core";
import { jsonRequest } from "./http";

export type GithubOptions = {
  /** https://api.github.com, or the mock's origin. */
  apiBase: string;
  token: string;
  /** Which repository each service lives in: service → "owner/name". */
  repos: Record<string, string>;
  testCommand?: string;
  fetch?: typeof fetch;
};

type Repo = { full_name: string; html_url: string; clone_url: string; default_branch: string; topics?: string[] };

/** Logins from a CODEOWNERS file's catch-all rule ("* @a @b"), or every owner it names. */
export function codeOwners(text: string): string[] {
  const rules = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const all = rules.find((l) => l.startsWith("* ")) ?? rules[0] ?? "";
  return all.split(/\s+/).filter((t) => t.startsWith("@") && !t.includes("/")).map((t) => t.slice(1));
}

/** GitHub's REST API (v3): the repository, a release's diff, people, and pull requests. It can open a pull request; it never merges one. */
export function githubCodeHost(options: GithubOptions): CodeHostPort {
  const api = <T>(method: "GET" | "POST", path: string, body?: unknown) =>
    jsonRequest<T>({ base: options.apiBase, token: options.token, ...(options.fetch ? { fetch: options.fetch } : {}), headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" } }, method, path, body);
  const user = async (login: string): Promise<CodeUser> => {
    const u = await api<{ login: string; name?: string | null; email?: string | null }>("GET", `/users/${encodeURIComponent(login)}`);
    return { login: u.login, name: u.name || u.login, ...(u.email ? { email: u.email } : {}) };
  };
  return {
    mode: "live",
    adapter: "github",
    async repoFor(service) {
      const fullName = options.repos[service];
      if (!fullName) return null;
      const repo = await api<Repo>("GET", `/repos/${fullName}`);
      let owners: string[] = [];
      try {
        const file = await api<{ content: string }>("GET", `/repos/${fullName}/contents/.github/CODEOWNERS?ref=${encodeURIComponent(repo.default_branch)}`);
        owners = codeOwners(Buffer.from(file.content, "base64").toString("utf8"));
      } catch {
        // No CODEOWNERS: nobody is required.
      }
      const info: RepoInfo = {
        service,
        fullName: repo.full_name,
        url: repo.html_url,
        cloneUrl: repo.clone_url,
        defaultBranch: repo.default_branch,
        architecture: repo.topics?.includes("monolith") ? "monolith" : "microservice",
        owners,
        testCommand: options.testCommand ?? "npm test",
      };
      return info;
    },
    async compare(repo, base, head) {
      const res = await api<{ files?: { filename: string; additions: number; deletions: number; patch?: string }[] }>("GET", `/repos/${repo.fullName}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
      return { files: (res.files ?? []).map((f) => ({ path: f.filename, additions: f.additions, deletions: f.deletions, patch: f.patch ?? "" })) };
    },
    async userByEmail(email) {
      const res = await api<{ items?: { login: string }[] }>("GET", `/search/users?q=${encodeURIComponent(`${email} in:email`)}`);
      const login = res.items?.[0]?.login;
      return login ? user(login) : null;
    },
    users: (logins) => Promise.all(logins.map(user)),
    async openPullRequest(repo, input) {
      const pr = await api<{ number: number; html_url: string }>("POST", `/repos/${repo.fullName}/pulls`, { title: input.title, head: input.branch, base: repo.defaultBranch, body: input.body, maintainer_can_modify: true });
      if (input.reviewers.length) await api("POST", `/repos/${repo.fullName}/pulls/${pr.number}/requested_reviewers`, { reviewers: input.reviewers });
      if (input.assignees.length) await api("POST", `/repos/${repo.fullName}/issues/${pr.number}/assignees`, { assignees: input.assignees });
      return { number: pr.number, url: pr.html_url };
    },
  };
}
