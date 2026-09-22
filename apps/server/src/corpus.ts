import type { Scenario } from "@crisiscrew/contracts";
import { DEFAULT_PROTOTYPES, prototypeTexts, ticketText } from "@crisiscrew/core";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { POOL_DIR } from "./paths";

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

/** Every text the engine embeds for scenarios, prototypes and the eval: what the embedding cache must hold. */
export function corpusTexts(scenarios: Iterable<Scenario>, pools: Pools): string[] {
  const texts = new Set(prototypeTexts(DEFAULT_PROTOTYPES));
  for (const s of scenarios) for (const t of s.tickets) texts.add(ticketText(t));
  for (const pool of Object.values(pools)) for (const text of pool) texts.add(ticketText({ body: text }));
  return [...texts];
}
