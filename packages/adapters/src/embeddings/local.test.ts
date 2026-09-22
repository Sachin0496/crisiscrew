import { beforeEach, describe, expect, it, vi } from "vitest";

// Tests never load the real model (a resource rule for the demo laptop), so the transformers.js pipeline is replaced.
const { pipeline, env } = vi.hoisted(() => ({ pipeline: vi.fn(), env: { cacheDir: "/library-default-cache" } }));
vi.mock("@huggingface/transformers", () => ({ pipeline, env }));

import { LocalEmbedder } from "./local";

type LoadOptions = { local_files_only: boolean };
const extractor = async (texts: string[]) => ({ tolist: () => texts.map(() => [0.6, 0.8]) });
const localFlags = () => pipeline.mock.calls.map((call) => (call[2] as LoadOptions).local_files_only);
const embedder = (offline: boolean) => new LocalEmbedder("test-model", { cacheDir: "/models", threads: 2, offline });

describe("LocalEmbedder", () => {
  beforeEach(() => {
    pipeline.mockReset();
  });

  it("uses a model already on disk without touching the network", async () => {
    pipeline.mockImplementation(async (_task: string, _id: string, options: LoadOptions) => {
      if (!options.local_files_only) throw new Error("network is down");
      return extractor;
    });
    await expect(embedder(false).embed(["checkout is stuck"])).resolves.toHaveLength(1);
    expect(localFlags()).toEqual([true]);
  });

  it("downloads the model when it isn't on disk yet", async () => {
    pipeline.mockImplementation(async (_task: string, _id: string, options: LoadOptions) => {
      if (options.local_files_only) throw new Error("not found locally");
      return extractor;
    });
    await expect(embedder(false).embed(["checkout is stuck"])).resolves.toHaveLength(1);
    expect(localFlags()).toEqual([true, false]);
  });

  it("never downloads when told to stay offline", async () => {
    pipeline.mockImplementation(async (_task: string, _id: string, options: LoadOptions) => {
      if (options.local_files_only) throw new Error("not found locally");
      return extractor;
    });
    await expect(embedder(true).embed(["checkout is stuck"])).rejects.toThrow("not found locally");
    expect(localFlags()).toEqual([true]);
  });

  it("points the library's default cache at the model folder, because some of its lookups ignore cache_dir", async () => {
    // transformers.js 4.3 checks for tokenizer files with empty options, so without this it looks in its own
    // cache, misses, and goes to the network even when the model is on disk.
    let cacheDuringLoad: string | undefined;
    pipeline.mockImplementation(async () => {
      cacheDuringLoad = env.cacheDir;
      return extractor;
    });
    await embedder(false).embed(["checkout is stuck"]);
    expect(cacheDuringLoad).toBe("/models");
  });

  it("tries again after a failed load instead of remembering the failure", async () => {
    let networkUp = false;
    pipeline.mockImplementation(async (_task: string, _id: string, options: LoadOptions) => {
      if (options.local_files_only || !networkUp) throw new Error("model unavailable");
      return extractor;
    });
    const e = embedder(false);
    await expect(e.embed(["checkout is stuck"])).rejects.toThrow("model unavailable");
    networkUp = true;
    await expect(e.embed(["checkout is stuck"])).resolves.toHaveLength(1);
  });
});
