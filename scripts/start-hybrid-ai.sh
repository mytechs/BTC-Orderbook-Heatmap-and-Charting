#!/usr/bin/env bash
set -euo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin:${PATH:-}"

MODEL="${1:-qwen3:4b}"
PORT="${HYBRID_AI_PORT:-11435}"
HOST="${HYBRID_AI_HOST:-127.0.0.1}"
CTX="${HYBRID_CTX:-8192}"
THREADS="${HYBRID_THREADS:-8}"
REASONING_BUDGET="${HYBRID_REASONING_BUDGET:-220}"

OLLAMA_LIB="/usr/local/lib/ollama"
CUDA_DIR="${OLLAMA_LIB}/cuda_v13"
if [ ! -d "$CUDA_DIR" ]; then
  CUDA_DIR="${OLLAMA_LIB}/cuda_v12"
fi

if [ ! -x "${OLLAMA_LIB}/llama-server" ]; then
  echo "Error: ${OLLAMA_LIB}/llama-server not found. Install/update Ollama first." >&2
  exit 1
fi

# Resolve GGUF blob path directly from Ollama (avoids re-downloading)
BLOB_PATH="$(ollama show --modelfile "$MODEL" 2>/dev/null | awk '/^FROM \/.*sha256-/{print $2; exit}')"
if [ -z "$BLOB_PATH" ] || [ ! -r "$BLOB_PATH" ]; then
  echo "Error: Could not find readable GGUF blob for Ollama model '$MODEL'." >&2
  echo "Make sure it is pulled first: ollama pull $MODEL" >&2
  exit 1
fi

RUNNER_DIR="${HOME}/.cache/btc-heatmap-llama-cuda"
mkdir -p "$RUNNER_DIR"
cp -f "${OLLAMA_LIB}/llama-server" "${RUNNER_DIR}/llama-server"
ln -sf "${OLLAMA_LIB}"/lib*.so* "$RUNNER_DIR/"
ln -sf "${CUDA_DIR}"/lib*.so* "$RUNNER_DIR/"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEFAULT_LORA="${PROJECT_DIR}/training/outputs/btc-neon-lite-4b-lora.gguf"

BLOB_BYTES="$(stat -c%s "$BLOB_PATH" 2>/dev/null || echo 0)"
# Small models (<5 GB) fit 100% inside 6 GB GPU VRAM; larger MoE models use Hybrid GPU+CPU unified memory
if [ -n "${HYBRID_N_CPU_MOE:-}" ]; then
  N_CPU_MOE="$HYBRID_N_CPU_MOE"
elif [ "$BLOB_BYTES" -gt 5000000000 ]; then
  N_CPU_MOE="20"
else
  N_CPU_MOE="0"
fi

EXTRA_ARGS=()
if [ "$N_CPU_MOE" -gt 0 ]; then
  EXTRA_ARGS+=(--n-cpu-moe "$N_CPU_MOE" --no-op-offload)
  MODE_LABEL="Hybrid GPU+CPU (--n-cpu-moe ${N_CPU_MOE})"
else
  MODE_LABEL="100% GPU VRAM"
fi

ALIAS="${MODEL//:/-}-local"
LORA_PATH="${HYBRID_LORA_PATH:-}"
if [ -z "$LORA_PATH" ] && [ "${HYBRID_NO_LORA:-0}" != "1" ] && [ "$MODEL" = "qwen3:4b" ] && [ -r "$DEFAULT_LORA" ]; then
  LORA_PATH="$DEFAULT_LORA"
  ALIAS="btc-neon-lite-4b"
fi
if [ -n "$LORA_PATH" ] && [ -r "$LORA_PATH" ]; then
  EXTRA_ARGS+=(--lora "$LORA_PATH")
  MODE_LABEL="${MODE_LABEL} + LoRA ($(basename "$LORA_PATH"))"
fi
QWEN3_TMPL="${PROJECT_DIR}/scripts/qwen3-chat-template.jinja"
if [[ "$MODEL" == qwen3* ]] && [ -r "$QWEN3_TMPL" ]; then
  EXTRA_ARGS+=(--jinja --chat-template-file "$QWEN3_TMPL")
fi
if [ "${HYBRID_USE_DRAFT:-0}" = "1" ] && [ "$MODEL" = "qwen3:4b" ]; then
  DRAFT_BLOB="$(ollama show --modelfile qwen3:0.6b 2>/dev/null | awk '/^FROM \/.*sha256-/{print $2; exit}')"
  if [ -n "$DRAFT_BLOB" ] && [ -r "$DRAFT_BLOB" ]; then
    EXTRA_ARGS+=(--spec-draft-model "$DRAFT_BLOB" --spec-draft-device CUDA0 --spec-draft-ngl 99 --spec-draft-n-max 6 --spec-draft-type-k q8_0 --spec-draft-type-v q8_0)
    MODE_LABEL="${MODE_LABEL} + Speculative(qwen3:0.6b)"
  fi
fi

echo "[Local GPU AI] Model: ${ALIAS}"
echo "[Local GPU AI] Blob:  ${BLOB_PATH}"
echo "[Local GPU AI] URL:   http://${HOST}:${PORT} (${MODE_LABEL} + ctx ${CTX} + reasoning-budget ${REASONING_BUDGET})"

export LD_LIBRARY_PATH="${RUNNER_DIR}"
export GGML_CUDA_ENABLE_UNIFIED_MEMORY=1

exec "${RUNNER_DIR}/llama-server" \
  -m "$BLOB_PATH" \
  --alias "$ALIAS" \
  --host "$HOST" \
  --port "$PORT" \
  --device CUDA0 \
  -ngl 99 \
  "${EXTRA_ARGS[@]}" \
  -np 1 \
  -c "$CTX" \
  -fa on \
  -ctk q8_0 \
  -ctv q8_0 \
  -t "$THREADS" \
  --reasoning-budget "$REASONING_BUDGET" \
  --fit off
