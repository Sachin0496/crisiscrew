#!/usr/bin/env bash
# Runs Laya (github.com/NandhaKishorM/laya, Apache 2.0) on this machine: the
# decision model behind CLASSIFIER=laya. It serves POST /v1/systemone on
# http://localhost:8000, which is LAYA_URL's default.
#
#   pnpm laya                      # English checkpoint (ModernBERT-large, 421M)
#   LAYA_MODELS=multilingual pnpm laya
#
# The first run makes a virtualenv in .laya/ and downloads the checkpoint
# from Hugging Face (about 1.7 GB for English) into the usual Hugging Face
# cache, so later runs start offline. Needs Python 3.10 or newer; uses uv
# when it's installed.
set -euo pipefail
cd "$(dirname "$0")/.."

VENV=.laya/venv
if [ ! -x "$VENV/bin/laya-serve" ]; then
  echo "Setting up Laya in $VENV (one time)..."
  if command -v uv >/dev/null 2>&1; then
    uv venv --python 3.12 "$VENV"
    uv pip install --python "$VENV/bin/python" "laya[serve]"
  else
    python3 -m venv "$VENV"
    "$VENV/bin/pip" install --upgrade pip
    "$VENV/bin/pip" install "laya[serve]"
  fi
fi

export LAYA_MODELS="${LAYA_MODELS:-english}"
export LAYA_PRELOAD="${LAYA_PRELOAD:-1}"
export LAYA_PORT="${LAYA_PORT:-8000}"
export LAYA_HOST="${LAYA_HOST:-127.0.0.1}"
echo "Starting Laya on http://$LAYA_HOST:$LAYA_PORT ($LAYA_MODELS). Set CLASSIFIER=laya in .env to use it."
exec "$VENV/bin/laya-serve"
