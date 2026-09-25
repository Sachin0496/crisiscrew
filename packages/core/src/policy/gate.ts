import type { AuditEntry, GuardFlag, GuardVerdict, Identity, Level, Policy } from "@crisiscrew/contracts";
import type { z } from "zod";
import type { Clock, PromptGuard } from "../ports";
import type { Tracer } from "../trace/tracer";
import type { AuditLog } from "./audit";

export type ToolDef<Ctx> = {
  name: string;
  description: string;
  input: z.ZodType;
  /** Authority needed for this particular call; may depend on the arguments (e.g. a credit's amount). */
  level: (args: unknown, ctx: Ctx) => Level;
  /** Every level a call can need, for display; defaults to the level of a call with no arguments. */
  levels?: Level[];
  /** Extra rule for L2/L3 calls: returns a refusal reason, or null to allow. */
  condition?: (args: unknown, ctx: Ctx) => string | null | Promise<string | null>;
  run: (args: unknown, ctx: Ctx) => Promise<unknown>;
  /** Which adapter serves the call ("sandbox", "freshdesk", "core", …), for the audit log; it may depend on the arguments. */
  adapter?: (ctx: Ctx, args?: unknown) => string;
  summarize?: (result: unknown) => string;
  /** Free text in the result that came from outside (a commit message, a status page), screened by the prompt guard. */
  untrusted?: (result: unknown) => string[];
};

export type ToolCallResult =
  | { ok: true; result: unknown; entry: AuditEntry; guard?: GuardVerdict }
  | { ok: false; reason: string; entry: AuditEntry };

/** Optional instrumentation: traces every call and screens untrusted text in tool outputs. */
export type GateHooks = {
  tracer?: Tracer;
  guard?: PromptGuard;
  onFlag?: (flag: GuardFlag) => void;
};

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
    private readonly hooks: GateHooks = {},
  ) {
    this.tools = new Map(tools.map((t) => [t.name, t]));
  }

  permitted(identity: Identity): ToolDef<Ctx>[] {
    const allowed = new Set(this.policy.identities[identity].tools);
    return [...this.tools.values()].filter((t) => allowed.has(t.name));
  }

  /** Each tool with its description and the authority levels its calls can need. */
  catalog(): { name: string; description: string; levels: Level[] }[] {
    const ctx = this.context();
    return [...this.tools.values()].map((t) => ({ name: t.name, description: t.description, levels: t.levels ?? [t.level({}, ctx)] }));
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

  /** Checks and runs one call. Traced as a tool span under the caller's current graph node, when a tracer is set. */
  async call(identity: Identity, name: string, args: unknown): Promise<ToolCallResult> {
    const tracer = this.hooks.tracer;
    if (!tracer) return this.check(identity, name, args);
    return tracer.span({ name, kind: "tool", actor: identity, input: args ?? {} }, () => this.check(identity, name, args), (r) => {
      const meta = { audit: r.entry.seq, level: r.entry.level, adapter: r.entry.adapter, decision: r.entry.decision };
      if (r.ok) return { status: "ok", output: { summary: r.entry.resultSummary, result: r.result }, meta };
      return { status: r.entry.decision === "denied" ? "denied" : "error", reason: r.reason, meta };
    });
  }

  private async check(identity: Identity, name: string, args: unknown): Promise<ToolCallResult> {
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

    // Permission first: a caller outside the allow-list learns nothing about the tool's arguments.
    const who = this.policy.identities[identity];
    if (!who.tools.includes(name)) return deny(`${who.name} is not allowed to call ${name}`, null);

    // Unknown fields are refused, not silently dropped: a call that says more than the tool accepts is suspect.
    const shape = (tool.input as unknown as { shape?: Record<string, unknown> }).shape;
    if (shape && args && typeof args === "object" && !Array.isArray(args)) {
      const unknown = Object.keys(args).filter((k) => !(k in shape));
      if (unknown.length > 0) return deny(`invalid arguments: unknown field${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")}`, null);
    }

    const parsed = tool.input.safeParse(args ?? {});
    if (!parsed.success) return deny(`invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"} ${i.message}`).join("; ")}`, null);

    const level = tool.level(parsed.data, ctx);
    if (level > who.maxLevel) return deny(`this ${name} call needs L${level}; ${who.name} is limited to L${who.maxLevel}`, level);

    const refusal = await tool.condition?.(parsed.data, ctx);
    if (refusal) return deny(refusal, level);

    const adapter = tool.adapter?.(ctx, parsed.data) ?? "core";
    try {
      const result = await withTimeout(tool.run(parsed.data, ctx), TIMEOUT_MS, name);
      const guard = tool.untrusted ? await this.screen(name, tool.untrusted(result)) : undefined;
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
      return { ok: true, result, entry, ...(guard ? { guard } : {}) };
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

  /**
   * Screens text a tool brought in from outside. The result is still returned:
   * it's data either way, and the agents never take instructions from it. A
   * flag is recorded in the trace and on the Governance page.
   */
  private async screen(tool: string, texts: string[]): Promise<GuardVerdict | undefined> {
    const guard = this.hooks.guard;
    const text = texts.filter(Boolean).join("\n");
    if (!guard || !text) return undefined;
    let verdict: GuardVerdict;
    try {
      verdict = await guard.screen(text);
    } catch (error) {
      this.hooks.tracer?.record({ name: "prompt_guard", kind: "guard", actor: "system", status: "warning", reason: `guard unavailable: ${error instanceof Error ? error.message : String(error)}` });
      return undefined;
    }
    this.hooks.tracer?.record({
      name: "prompt_guard",
      kind: "guard",
      actor: "system",
      status: verdict.flagged ? "flagged" : "ok",
      ...(verdict.flagged ? { reason: `instruction-like text in ${tool} output: ${verdict.reasons.join(", ")}` } : {}),
      input: { source: `${tool} output`, text },
      output: verdict,
    });
    if (verdict.flagged) this.hooks.onFlag?.({ at: this.clock.now(), source: "tool_output", ref: tool, verdict, excerpt: clip(text, 160) });
    return verdict;
  }
}
