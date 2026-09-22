import { fileURLToPath } from "node:url";

const root = new URL("../../../", import.meta.url);

export const REPO_ROOT = fileURLToPath(root);
export const SCENARIO_DIR = new URL("scenarios/", root);
export const POOL_DIR = new URL("scenarios/pools/", root);
export const EMBEDDING_CACHE_DIR = fileURLToPath(new URL("scenarios/.embeddings/", root));
export const MODELS_DIR = fileURLToPath(new URL(".models/", root));
export const POLICY_FILE = new URL("config/policy.json", root);
export const DATA_DIR = fileURLToPath(new URL("data/", root));
export const WEB_DIST_DIR = fileURLToPath(new URL("apps/web/dist/", root));
export const EVAL_DOC = new URL("docs/eval.md", root);
