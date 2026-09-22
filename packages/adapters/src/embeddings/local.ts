import type { Embedder } from "@crisiscrew/core";
import { env, pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

export type LocalEmbedderOptions = {
  /** Where model files are downloaded to, or read from when offline. */
  cacheDir: string;
  /** ONNX intra-op threads; 2 keeps a fanless laptop from throttling. */
  threads: number;
  /** Use only files already in cacheDir; never download. */
  offline: boolean;
};

/**
 * Sentence embeddings computed on this machine with transformers.js
 * (quantized ONNX model, mean pooling, L2-normalised). The model loads on
 * first use.
 */
export class LocalEmbedder implements Embedder {
  private extractor: Promise<FeatureExtractionPipeline> | null = null;

  constructor(
    readonly id: string,
    private readonly options: LocalEmbedderOptions,
  ) {}

  /**
   * Loads from disk first, so a model that's already downloaded never needs the
   * network (venue Wi-Fi can drop mid-demo). Downloads only when the model isn't
   * on disk and offline is off. A failed load isn't remembered, so the next call tries again.
   */
  private load(): Promise<FeatureExtractionPipeline> {
    // transformers.js 4.3 checks for some files (the tokenizer config) with empty options, ignoring cache_dir, so
    // it would look in its own cache, miss, and go to the network. Its default cache has to be this folder too.
    env.cacheDir = this.options.cacheDir;
    const open = (localFilesOnly: boolean) =>
      pipeline("feature-extraction", this.id, {
        dtype: "q8",
        cache_dir: this.options.cacheDir,
        local_files_only: localFilesOnly,
        session_options: { intraOpNumThreads: this.options.threads, interOpNumThreads: 1 },
      }) as Promise<FeatureExtractionPipeline>;
    this.extractor ??= open(true)
      .catch((error: unknown) => {
        if (this.options.offline) throw error;
        return open(false);
      })
      .catch((error: unknown) => {
        this.extractor = null;
        throw error;
      });
    return this.extractor;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const extractor = await this.load();
    const vectors: Float32Array[] = [];
    // Small batches keep peak memory low.
    for (let i = 0; i < texts.length; i += 16) {
      const output = await extractor(texts.slice(i, i + 16), { pooling: "mean", normalize: true });
      for (const row of output.tolist() as number[][]) vectors.push(Float32Array.from(row));
    }
    return vectors;
  }
}
