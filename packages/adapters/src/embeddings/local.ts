import type { Embedder } from "@crisiscrew/core";
import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

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

  private load(): Promise<FeatureExtractionPipeline> {
    this.extractor ??= pipeline("feature-extraction", this.id, {
      dtype: "q8",
      cache_dir: this.options.cacheDir,
      local_files_only: this.options.offline,
      session_options: { intraOpNumThreads: this.options.threads, interOpNumThreads: 1 },
    }) as Promise<FeatureExtractionPipeline>;
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
