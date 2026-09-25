/**
 * Computes embeddings for every scenario, prototype and eval text with the
 * local model and stores them in scenarios/.embeddings/, so tests and CI
 * never load a model.
 *
 *   pnpm embeddings:warm                       # the model in EMBEDDINGS_MODEL
 *   pnpm embeddings:warm Xenova/all-MiniLM-L6-v2 Xenova/paraphrase-multilingual-MiniLM-L12-v2
 */
import { CachedEmbedder, LocalEmbedder } from "@crisiscrew/adapters";
import { corpusTexts, loadPools, loadSecurityCorpus } from "../corpus";
import { EMBEDDING_CACHE_DIR, MODELS_DIR } from "../paths";
import { loadScenarios } from "../scenarios";

const models = process.argv.slice(2).filter((a) => !a.startsWith("-"));
if (models.length === 0) models.push(process.env.EMBEDDINGS_MODEL || "Xenova/all-MiniLM-L6-v2");

const texts = corpusTexts(loadScenarios().values(), loadPools(), loadSecurityCorpus());
console.log(`${texts.length} texts to embed`);

for (const modelId of models) {
  const started = Date.now();
  const local = new LocalEmbedder(modelId, {
    cacheDir: process.env.EMBEDDINGS_MODEL_DIR || MODELS_DIR,
    threads: Number(process.env.EMBEDDINGS_THREADS || 2),
    offline: false,
  });
  const cached = new CachedEmbedder({ modelId, dir: EMBEDDING_CACHE_DIR, inner: local });
  await cached.embed(texts);
  console.log(`${modelId}: done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}
