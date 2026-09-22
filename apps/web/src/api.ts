import type { Approval, CrisisState, DecisionBody, Level, Scenario, Ticket, WiringReport } from "@crisiscrew/contracts";

type Expected = Scenario["expected"];

export type Health = {
  ok: boolean;
  version: string;
  session: CrisisState["session"];
  auth: { admin: boolean; approver: boolean };
};

export type ScenarioSummary = { id: string; title: string; purpose: string; speed: number; expected: Expected; tickets: number };

export type PolicyView = {
  identities: { identity: string; name: string; maxLevel: Level; tools: { name: string; allowed: boolean }[] }[];
  tools: { name: string; description: string; levels: Level[] }[];
  levelNames: Record<string, string>;
  limits: { authorityLimitInr: number; creditPerCustomerInr: number };
};

export type AuditVerify = { ok: boolean; count: number; brokenAt?: number };

type Role = "admin" | "approver";

function token(role: Role): string | null {
  try {
    return sessionStorage.getItem(`crisiscrew.${role}`);
  } catch {
    return null;
  }
}

function saveToken(role: Role, value: string): void {
  try {
    sessionStorage.setItem(`crisiscrew.${role}`, value);
  } catch {
    /* private mode: the token lasts for this request only */
  }
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return (await res.json()) as T;
}

/** POSTs JSON. If the server asks for a token, prompts once, remembers it for the tab, and retries. */
async function post<T>(path: string, body: unknown, role: Role): Promise<T> {
  const send = (secret: string | null) =>
    fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
      body: JSON.stringify(body),
    });
  let res = await send(token(role));
  if (res.status === 401) {
    const entered = window.prompt(`This server needs the ${role} token (see ${role === "admin" ? "ADMIN_TOKEN" : "APPROVER_TOKEN"} in .env).`);
    if (!entered) throw new Error(`${role} token required`);
    saveToken(role, entered);
    res = await send(entered);
  }
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `${path}: ${res.status}`);
  return data;
}

export const api = {
  health: () => get<Health>("/api/health"),
  wiring: () => get<WiringReport>("/api/wiring"),
  scenarios: () => get<ScenarioSummary[]>("/api/scenarios"),
  policy: () => get<PolicyView>("/api/policy"),
  verifyAudit: () => get<AuditVerify>("/api/audit/verify"),
  state: () => get<CrisisState>("/api/state"),
  replay: (scenario: string, speed: number) => post<{ sessionId: string }>("/api/replay", { scenario, speed }, "admin"),
  live: () => post<{ sessionId: string }>("/api/live", {}, "admin"),
  addTicket: (ticket: { customerName: string; channel: string; body: string }) => post<Ticket>("/api/tickets", ticket, "admin"),
  decide: (approvalId: string, body: DecisionBody) => post<Approval>(`/api/approvals/${approvalId}`, body, "approver"),
};
