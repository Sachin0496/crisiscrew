import { parsePolicy, TOOL_NAMES, type AuditEntry, type Level } from "@crisiscrew/contracts";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import policyJson from "../../../../config/policy.json";
import { ManualClock } from "../clock";
import { AuditLog } from "./audit";
import { PolicyGate, type ToolDef } from "./gate";

const policy = parsePolicy(policyJson, TOOL_NAMES);

type Ctx = { approvals: Map<string, { status: string; approvedAmountInr?: number }> };

function tool(name: string, level: Level | ((args: { amountInr?: number }) => Level), extra: Partial<ToolDef<Ctx>> = {}): ToolDef<Ctx> {
  return {
    name,
    description: name,
    input: z.object({ amountInr: z.number().optional(), approvalId: z.string().optional() }).loose(),
    level: typeof level === "function" ? (args) => level(args as { amountInr?: number }) : () => level,
    run: vi.fn(async () => ({ done: name })),
    ...extra,
  };
}

function setup(tools: ToolDef<Ctx>[]) {
  const audit = new AuditLog();
  const ctx: Ctx = { approvals: new Map() };
  const gate = new PolicyGate(policy, tools, audit, new ManualClock(1_000), () => ctx);
  return { gate, audit, ctx };
}

describe("PolicyGate", () => {
  it("runs an allow-listed read tool and audits it as allowed", async () => {
    const health = tool("get_payment_health", 0);
    const { gate, audit } = setup([health]);
    const out = await gate.call("investigator", "get_payment_health", {});
    expect(out.ok).toBe(true);
    expect(health.run).toHaveBeenCalledOnce();
    expect(audit.entries()[0]).toMatchObject({ identity: "investigator", tool: "get_payment_health", decision: "allowed", outcome: "ok", level: 0 });
  });

  it("denies the read-only Pattern Agent a write, audits the denial, and never runs the tool", async () => {
    const link = tool("link_ticket_to_incident", 1);
    const { gate, audit } = setup([link]);
    const out = await gate.call("pattern", "link_ticket_to_incident", {});
    expect(out.ok).toBe(false);
    expect(link.run).not.toHaveBeenCalled();
    expect(audit.entries()[0]).toMatchObject({ identity: "pattern", decision: "denied" });
    expect(audit.entries()[0]?.reason).toMatch(/not allowed/);
  });

  it("refuses a caller outside the allow-list before looking at its arguments", async () => {
    const strict = tool("link_ticket_to_incident", 1, { input: z.object({ incidentId: z.string(), ticketId: z.string() }) });
    const { gate } = setup([strict]);
    const out = await gate.call("pattern", "link_ticket_to_incident", {});
    expect(out).toMatchObject({ ok: false });
    expect(out.ok ? "" : out.reason).toMatch(/not allowed/);
    expect(out.ok ? "" : out.reason).not.toMatch(/incidentId/);
  });

  it("keeps external MCP clients read-only", async () => {
    const send = tool("send_customer_update", 2);
    const { gate } = setup([send]);
    expect((await gate.call("operator", "send_customer_update", {})).ok).toBe(false);
    expect(send.run).not.toHaveBeenCalled();
  });

  it("denies an allow-listed tool when this call's level exceeds the caller's authority", async () => {
    // A credit is L2 within the ₹500 per-customer limit and L3 above it; Recovery is capped at L2.
    const credit = tool("issue_recovery_credit", (args) => ((args.amountInr ?? 0) > 500 ? 3 : 2));
    const { gate, audit } = setup([credit]);
    expect((await gate.call("recovery", "issue_recovery_credit", { amountInr: 200 })).ok).toBe(true);
    const over = await gate.call("recovery", "issue_recovery_credit", { amountInr: 1_000 });
    expect(over.ok).toBe(false);
    expect(audit.entries()[1]).toMatchObject({ decision: "denied", level: 3 });
    expect(credit.run).toHaveBeenCalledOnce();
  });

  it("denies when the tool's own condition fails, with the condition's reason", async () => {
    const credit = tool("issue_recovery_credit", 3, {
      condition: (args, ctx) => {
        const a = ctx.approvals.get(String((args as { approvalId?: string }).approvalId));
        if (!a || (a.status !== "approved" && a.status !== "modified")) return "needs an approved approval";
        return (args as { amountInr?: number }).amountInr === a.approvedAmountInr ? null : "amount differs from the approved amount";
      },
    });
    const { gate, ctx } = setup([credit]);
    ctx.approvals.set("APR-1", { status: "pending" });
    expect(await gate.call("handoff", "issue_recovery_credit", { approvalId: "APR-1", amountInr: 1_000 })).toMatchObject({
      ok: false,
      reason: "needs an approved approval",
    });
    ctx.approvals.set("APR-1", { status: "modified", approvedAmountInr: 500 });
    expect(await gate.call("handoff", "issue_recovery_credit", { approvalId: "APR-1", amountInr: 1_000 })).toMatchObject({
      ok: false,
      reason: "amount differs from the approved amount",
    });
    expect((await gate.call("handoff", "issue_recovery_credit", { approvalId: "APR-1", amountInr: 500 })).ok).toBe(true);
    expect(credit.run).toHaveBeenCalledOnce();
  });

  it("audits a tool that throws as allowed with an error outcome", async () => {
    const broken = tool("get_recent_deployments", 0, { run: async () => Promise.reject(new Error("GitHub timed out")) });
    const { gate, audit } = setup([broken]);
    const out = await gate.call("investigator", "get_recent_deployments", {});
    expect(out).toMatchObject({ ok: false, reason: "GitHub timed out" });
    expect(audit.entries()[0]).toMatchObject({ decision: "allowed", outcome: "error" });
  });

  it("denies an unknown tool and invalid arguments", async () => {
    const strict = tool("get_incident", 0, { input: z.object({ incidentId: z.string() }) });
    const { gate } = setup([strict]);
    expect(await gate.call("operator", "delete_everything", {})).toMatchObject({ ok: false });
    expect(await gate.call("operator", "get_incident", { incidentId: 7 })).toMatchObject({ ok: false });
    expect(strict.run).not.toHaveBeenCalled();
  });

  it("lists exactly the tools each identity may call", () => {
    const { gate } = setup(TOOL_NAMES.map((n) => tool(n, 0)));
    const matrix = gate.matrix();
    const pattern = matrix.find((m) => m.identity === "pattern");
    expect(pattern?.tools.filter((t) => t.allowed).map((t) => t.name)).toEqual(["search_recent_tickets", "get_incident"]);
    expect(gate.permitted("operator").map((t) => t.name).sort()).toEqual(
      [
        "get_customer_impact",
        "get_incident",
        "get_payment_health",
        "get_recent_deployments",
        "get_recovery_coverage",
        "get_service_status",
        "search_recent_tickets",
      ].sort(),
    );
  });
});

describe("AuditLog", () => {
  const draft = (tool: string) => ({
    at: 1,
    identity: "investigator" as const,
    tool,
    level: 0 as const,
    argsSummary: "{}",
    decision: "allowed" as const,
    outcome: "ok" as const,
    adapter: "sandbox",
    durationMs: 1,
  });

  it("chains every entry to the previous one", () => {
    const log = new AuditLog();
    const a = log.append(draft("a"));
    const b = log.append(draft("b"));
    expect(b.prevHash).toBe(a.hash);
    expect([a.seq, b.seq]).toEqual([1, 2]);
    expect(log.verify()).toEqual({ ok: true, count: 2 });
  });

  it("detects an edited entry and says where the chain breaks", () => {
    const log = new AuditLog();
    for (const t of ["a", "b", "c"]) log.append(draft(t));
    (log.entries()[1] as AuditEntry).argsSummary = '{"amountInr":1}';
    expect(log.verify()).toEqual({ ok: false, count: 3, brokenAt: 2 });
  });

  it("reports each appended entry to its listener", () => {
    const seen: string[] = [];
    const log = new AuditLog((e) => seen.push(e.tool));
    log.append(draft("x"));
    expect(seen).toEqual(["x"]);
  });
});
