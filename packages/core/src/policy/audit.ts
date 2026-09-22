import type { AuditEntry } from "@crisiscrew/contracts";
import { createHash } from "node:crypto";

export type AuditDraft = Omit<AuditEntry, "seq" | "prevHash" | "hash">;

const GENESIS = "0".repeat(64);

function digest(entry: Omit<AuditEntry, "hash">): string {
  // Fixed field order so the hash never depends on object key order.
  const canonical = JSON.stringify([
    entry.seq,
    entry.at,
    entry.identity,
    entry.tool,
    entry.level,
    entry.argsSummary,
    entry.decision,
    entry.reason ?? null,
    entry.outcome ?? null,
    entry.resultSummary ?? null,
    entry.adapter,
    entry.durationMs,
    entry.prevHash,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Append-only, hash-chained record of every tool call. Each entry carries
 * the SHA-256 of the previous one, so editing any entry breaks the chain.
 */
export class AuditLog {
  private readonly items: AuditEntry[] = [];

  constructor(private readonly onAppend?: (entry: AuditEntry) => void) {}

  append(draft: AuditDraft): AuditEntry {
    const prevHash = this.items.at(-1)?.hash ?? GENESIS;
    const unsigned = { ...draft, seq: this.items.length + 1, prevHash };
    const entry: AuditEntry = { ...unsigned, hash: digest(unsigned) };
    this.items.push(entry);
    this.onAppend?.(entry);
    return entry;
  }

  entries(): readonly AuditEntry[] {
    return this.items;
  }

  verify(): { ok: true; count: number } | { ok: false; count: number; brokenAt: number } {
    let prev = GENESIS;
    for (const entry of this.items) {
      const { hash, ...rest } = entry;
      if (entry.prevHash !== prev || digest(rest) !== hash) return { ok: false, count: this.items.length, brokenAt: entry.seq };
      prev = hash;
    }
    return { ok: true, count: this.items.length };
  }
}
