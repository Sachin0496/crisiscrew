import type { AuditEntry, Identity, Level, Policy } from "@crisiscrew/contracts";
import type { z } from "zod";
import type { Clock } from "../ports";
import type { AuditLog } from "./audit";

export type ToolDef<Ctx> = {
  name: string;
  description: string;
  input: z.ZodType;
  /** Authority needed for this particular call; may depend on the arguments (e.g. a credit's amount). */
  level: (args: unknown, ctx: Ctx) => Level;
  /** Extra rule for L2/L3 calls: returns a refusal reason, or null to allow. */
  condition?: (args: unknown, ctx: Ctx) => string | null;
  run: (args: unknown, ctx: Ctx) => Promise<unknown>;
  /** Which adapter served the call ("sandbox", "core", …), for the audit log. */
  adapter?: (ctx: Ctx) => string;
  summarize?: (result: unknown) => string;
};

export type ToolCallResult =
  | { ok: true; result: unknown; entry: AuditEntry }
  | { ok: false; reason: string; entry: AuditEntry };

const TIMEOUT_MS = 5_000;

function clip(text: string, max = 240): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function withTimeout<T>(promise: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${name} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The only path from an agent (or MCP client) to a tool. Every call is
 * checked against the caller's allow-list, the call's authority level, and
 * the tool's own condition, then recorded in the audit log whatever the outcome.
 */
export class PolicyGate<Ctx> {
  private readonly tools: Map<string, ToolDef<Ctx>>;

  constructor(
    private readonly policy: Policy,
    tools: ToolDef<Ctx>[],
    private readonly audit: AuditLog,
    private readonly clock: Clock,
    private readonly context: () => Ctx,
  ) {
    this.tools = new Map(tools.map((t) => [t.name, t]));
  }

  permitted(identity: Identity): ToolDef<Ctx>[] {
    const allowed = new Set(this.policy.identities[identity].tools);
    return [...this.tools.values()].filter((t) => allowed.has(t.name));
  }

  matrix(): { identity: Identity; name: string; maxLevel: Level; tools: { name: string; allowed: boolean }[] }[] {
    return (Object.keys(this.policy.identities) as Identity[]).map((identity) => {
      const entry = this.policy.identities[identity];
      const allowed = new Set(entry.tools);
      return {
        identity,
        name: entry.name,
        maxLevel: entry.maxLevel,
        tools: [...this.tools.keys()].map((name) => ({ name, allowed: allowed.has(name) })),
      };
    });
  }

  async call(identity: Identity, name: string, args: unknown): Promise<ToolCallResult> {
    const started = this.clock.now();
    const ctx = this.context();
    const tool = this.tools.get(name);
    const argsSummary = clip(JSON.stringify(args ?? {}));
    const base = { at: started, identity, tool: name, argsSummary };

    const deny = (reason: string, level: Level | null): ToolCallResult => ({
      ok: false,
      reason,
      entry: this.audit.append({ ...base, level, decision: "denied", reason, adapter: tool?.adapter?.(ctx) ?? "core", durationMs: 0 }),
    });

    if (!tool) return deny(`unknown tool "${name}"`, null);

    const parsed = tool.input.safeParse(args ?? {});
    if (!parsed.success) return deny(`invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"} ${i.message}`).join("; ")}`, null);

    const who = this.policy.identities[identity];
    if (!who.tools.includes(name)) return deny(`${who.name} is not allowed to call ${name}`, null);

    const level = tool.level(parsed.data, ctx);
    if (level > who.maxLevel) return deny(`this ${name} call needs L${level}; ${who.name} is limited to L${who.maxLevel}`, level);

    const refusal = tool.condition?.(parsed.data, ctx);
    if (refusal) return deny(refusal, level);

    const adapter = tool.adapter?.(ctx) ?? "core";
    try {
      const result = await withTimeout(tool.run(parsed.data, ctx), TIMEOUT_MS, name);
      const resultSummary = clip(tool.summarize ? tool.summarize(result) : JSON.stringify(result ?? null));
      const entry = this.audit.append({
        ...base,
        level,
        decision: "allowed",
        outcome: "ok",
        resultSummary,
        adapter,
        durationMs: Math.max(0, Math.round(this.clock.now() - started)),
      });
      return { ok: true, result, entry };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const entry = this.audit.append({
        ...base,
        level,
        decision: "allowed",
        outcome: "error",
        reason,
        adapter,
        durationMs: Math.max(0, Math.round(this.clock.now() - started)),
      });
      return { ok: false, reason, entry };
    }
  }
}
