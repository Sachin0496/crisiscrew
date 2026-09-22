import { hashSeed, type Embedder } from "@crisiscrew/core";

/**
 * Deterministic bag-of-words hashing. Fast and dependency-free, for unit
 * tests only: it matches shared words, not meaning, so it can't correlate
 * complaints written in different words.
 */
export class HashEmbedder implements Embedder {
  readonly id = "hash";

  constructor(private readonly dim = 384) {}

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => {
      const v = new Float32Array(this.dim);
      for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
        const h = hashSeed(word);
        v[h % this.dim]! += (h >>> 16) & 1 ? 1 : -1;
      }
      const length = Math.hypot(...v);
      return length === 0 ? v : v.map((x) => x / length);
    });
  }
}
