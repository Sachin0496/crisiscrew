import type { Embedder } from "@crisiscrew/core";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export class EmbeddingCacheMiss extends Error {
  override name = "EmbeddingCacheMiss";
}

export function modelSlug(modelId: string): string {
  return modelId.replace(/[^A-Za-z0-9.-]+/g, "_");
}

function cacheKey(modelId: string, text: string): string {
  return createHash("sha256").update(`${modelId}\n${text}`).digest("hex");
}

function encode(v: Float32Array): string {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");
}

function decode(b64: string): Float32Array {
  const bytes = Buffer.from(b64, "base64");
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

export type CachedEmbedderOptions = {
  modelId: string;
  /** Folder holding one `<model>.jsonl` file per model. */
  dir: string;
  /** The real model; null means cache-only (tests and CI), and a miss throws. */
  inner: Embedder | null;
};

/**
 * Embeddings keyed by model and text, persisted as JSON lines. Scenario and
 * eval texts are committed, so tests and CI never load a model.
 */
export class CachedEmbedder implements Embedder {
  readonly id: string;
  private readonly file: string;
  private memory: Map<string, Float32Array> | null = null;

  constructor(private readonly options: CachedEmbedderOptions) {
    this.id = options.modelId;
    this.file = join(options.dir, `${modelSlug(options.modelId)}.jsonl`);
  }

  private load(): Map<string, Float32Array> {
    if (this.memory) return this.memory;
    const memory = new Map<string, Float32Array>();
    if (existsSync(this.file)) {
      for (const line of readFileSync(this.file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line) as { k: string; v: string };
        memory.set(entry.k, decode(entry.v));
      }
    }
    this.memory = memory;
    return memory;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const memory = this.load();
    const keys = texts.map((t) => cacheKey(this.id, t));
    const missing = [...new Set(texts.filter((_, i) => !memory.has(keys[i]!)))];

    if (missing.length > 0) {
      if (!this.options.inner) {
        throw new EmbeddingCacheMiss(
          `No cached embedding from ${this.id} for "${missing[0]}"` +
            (missing.length > 1 ? ` (and ${missing.length - 1} more)` : "") +
            ". Run `pnpm embeddings:warm` with the model available.",
        );
      }
      const vectors = await this.options.inner.embed(missing);
      mkdirSync(this.options.dir, { recursive: true });
      const lines = missing.map((text, i) => {
        const key = cacheKey(this.id, text);
        memory.set(key, vectors[i]!);
        return JSON.stringify({ k: key, t: text, v: encode(vectors[i]!) });
      });
      appendFileSync(this.file, `${lines.join("\n")}\n`);
    }

    return keys.map((k) => memory.get(k)!);
  }
}
