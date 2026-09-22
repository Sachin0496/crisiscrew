import { cosine, norm, type Embedder } from "@crisiscrew/core";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CachedEmbedder, EmbeddingCacheMiss } from "./cached";
import { HashEmbedder } from "./hash";

describe("HashEmbedder", () => {
  const hash = new HashEmbedder();

  it("returns the same unit-length vector for the same text", async () => {
    const [a, b] = await hash.embed(["Checkout is stuck", "Checkout is stuck"]);
    expect(Array.from(a!)).toEqual(Array.from(b!));
    expect(norm(a!)).toBeCloseTo(1, 5);
    expect(a!.length).toBe(384);
  });

  it("scores texts that share words above texts that share none", async () => {
    const [a, b, c] = await hash.embed(["checkout payment failed", "payment failed at checkout", "where is my parcel"]);
    expect(cosine(a!, b!)).toBeGreaterThan(cosine(a!, c!));
  });
});

class CountingEmbedder implements Embedder {
  readonly id = "counting-model";
  calls: string[][] = [];
  async embed(texts: string[]) {
    this.calls.push(texts);
    return texts.map((t) => Float32Array.from([t.length, 1, 0]));
  }
}

describe("CachedEmbedder", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("embeds only the texts it hasn't seen and serves repeats from the cache file", async () => {
    dir = mkdtempSync(join(tmpdir(), "cc-embed-"));
    const inner = new CountingEmbedder();
    const cached = new CachedEmbedder({ modelId: inner.id, dir, inner });

    await cached.embed(["alpha", "beta"]);
    await cached.embed(["beta", "gamma", "alpha"]);
    expect(inner.calls).toEqual([["alpha", "beta"], ["gamma"]]);

    // A fresh instance with no model reads everything back from disk.
    const fromDisk = new CachedEmbedder({ modelId: inner.id, dir, inner: null });
    const [gamma] = await fromDisk.embed(["gamma"]);
    expect(Array.from(gamma!)).toEqual([5, 1, 0]);
    expect(readFileSync(join(dir, "counting-model.jsonl"), "utf8").trim().split("\n")).toHaveLength(3);
  });

  it("throws a cache miss naming the text when no model is available", async () => {
    dir = mkdtempSync(join(tmpdir(), "cc-embed-"));
    const cached = new CachedEmbedder({ modelId: "absent-model", dir, inner: null });
    await expect(cached.embed(["never embedded"])).rejects.toThrow(EmbeddingCacheMiss);
    await expect(cached.embed(["never embedded"])).rejects.toThrow(/never embedded/);
  });

  it("in read-only mode, passes misses to the next layer and never writes its own file", async () => {
    dir = mkdtempSync(join(tmpdir(), "cc-embed-"));
    const inner = new CountingEmbedder();
    const committed = new CachedEmbedder({ modelId: inner.id, dir: join(dir, "committed"), inner, readOnly: true });
    const [v] = await committed.embed(["typed by a judge"]);
    expect(Array.from(v!)).toEqual([16, 1, 0]);
    expect(existsSync(join(dir, "committed", "counting-model.jsonl"))).toBe(false);
  });

  it("keeps each model's vectors separate", async () => {
    dir = mkdtempSync(join(tmpdir(), "cc-embed-"));
    const inner = new CountingEmbedder();
    await new CachedEmbedder({ modelId: inner.id, dir, inner }).embed(["alpha"]);
    const other = new CachedEmbedder({ modelId: "other-model", dir, inner: null });
    await expect(other.embed(["alpha"])).rejects.toThrow(EmbeddingCacheMiss);
  });
});
