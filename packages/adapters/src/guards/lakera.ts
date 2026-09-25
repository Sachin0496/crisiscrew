import type { GuardVerdict } from "@crisiscrew/contracts";
import type { PromptGuard } from "@crisiscrew/core";
import { z } from "zod";

/**
 * Lakera Guard (https://docs.lakera.ai): a hosted prompt-injection and
 * data-leak classifier. POST /v2/guard with the text as a user message; it
 * answers whether it's flagged and, with breakdown on, which detectors fired.
 * It is a separate model from the incident classifier, as it should be.
 */

const LakeraResponse = z.object({
  flagged: z.boolean(),
  breakdown: z.array(z.object({ detector_type: z.string(), detected: z.boolean() }).loose()).optional(),
});

export type LakeraOptions = {
  apiKey: string;
  /** A Lakera project whose policy to apply; the default policy otherwise. */
  projectId?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export class LakeraGuard implements PromptGuard {
  readonly mode = "live" as const;
  readonly adapter = "lakera";

  constructor(private readonly options: LakeraOptions) {}

  async screen(text: string): Promise<GuardVerdict> {
    const base = (this.options.baseUrl ?? "https://api.lakera.ai").replace(/\/+$/, "");
    const res = await (this.options.fetch ?? fetch)(`${base}/v2/guard`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.options.apiKey}` },
      body: JSON.stringify({ messages: [{ role: "user", content: text }], breakdown: true, ...(this.options.projectId ? { project_id: this.options.projectId } : {}) }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 2_000),
    });
    if (!res.ok) throw new Error(`Lakera Guard answered ${res.status}`);
    const parsed = LakeraResponse.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new Error("Lakera Guard's answer didn't have the expected shape");
    const detected = (parsed.data.breakdown ?? []).filter((d) => d.detected).map((d) => d.detector_type);
    return { flagged: parsed.data.flagged, score: parsed.data.flagged ? 1 : 0, reasons: detected, guard: "lakera", matches: [] };
  }
}

/**
 * Defence in depth: every guard screens the text and it's flagged if any of
 * them flags it. A guard that fails is skipped (and named in the verdict);
 * if every guard fails, the call fails and the caller falls back.
 */
export function layeredGuard(guards: PromptGuard[]): PromptGuard {
  return {
    mode: guards.some((g) => g.mode === "live") ? "live" : "sandbox",
    adapter: guards.map((g) => g.adapter).join("+"),
    async screen(text) {
      const results = await Promise.allSettled(guards.map((g) => g.screen(text)));
      const verdicts = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      if (verdicts.length === 0) throw (results[0] as PromiseRejectedResult).reason;
      const failed = guards.filter((_, i) => results[i]!.status === "rejected").map((g) => g.adapter);
      return {
        flagged: verdicts.some((v) => v.flagged),
        score: Math.max(...verdicts.map((v) => v.score)),
        reasons: [...new Set(verdicts.flatMap((v) => v.reasons))],
        guard: `${verdicts.map((v) => v.guard).join("+")}${failed.length ? ` (${failed.join(", ")} unavailable)` : ""}`,
        matches: verdicts.flatMap((v) => v.matches),
      };
    },
  };
}
