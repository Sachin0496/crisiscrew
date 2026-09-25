import type { Scenario } from "@crisiscrew/contracts";
import { DEFAULT_PROTOTYPES, prototypeTexts, ticketText } from "@crisiscrew/core";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { POOL_DIR, SECURITY_CORPUS } from "./paths";

export type Pools = Record<string, string[]>;

/** Paraphrase pools used by the eval, keyed by pool name (the file name without .json). */
export function loadPools(dir: URL = POOL_DIR): Pools {
  if (!existsSync(dir)) return {};
  const pools: Pools = {};
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const texts = JSON.parse(readFileSync(new URL(file, dir), "utf8")) as unknown;
    if (!Array.isArray(texts) || !texts.every((t) => typeof t === "string")) throw new Error(`Pool ${file} must be a JSON array of strings`);
    pools[file.replace(/\.json$/, "")] = texts;
  }
  return pools;
}

export type SecurityCorpus = { attacks: { category: string; text: string }[]; benign: { note: string; text: string }[] };

/** The prompt-injection attacks and hard benign look-alikes behind the guard evaluation and the security tests. */
export function loadSecurityCorpus(file: URL = SECURITY_CORPUS): SecurityCorpus {
  return JSON.parse(readFileSync(file, "utf8")) as SecurityCorpus;
}

/** Every text the engine embeds for scenarios, prototypes, the eval and the security suite: what the embedding cache must hold. */
export function corpusTexts(scenarios: Iterable<Scenario>, pools: Pools, security: SecurityCorpus | null = null): string[] {
  const texts = new Set(prototypeTexts(DEFAULT_PROTOTYPES));
  for (const s of scenarios) for (const t of s.tickets) texts.add(ticketText(t));
  for (const pool of Object.values(pools)) for (const text of pool) texts.add(ticketText({ body: text }));
  for (const item of [...(security?.attacks ?? []), ...(security?.benign ?? [])]) texts.add(ticketText({ body: item.text }));
  return [...texts];
}
