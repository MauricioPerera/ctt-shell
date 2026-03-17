#!/bin/bash
# Start embeddinggemma via llama-server (no Ollama dependency)
# Usage: ./scripts/start-embedding-server.sh [port]

PORT=${1:-9999}
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TOOLS_DIR="$SCRIPT_DIR/../tools"
MODEL="$TOOLS_DIR/embeddinggemma-300M-Q8_0.gguf"
SERVER="$TOOLS_DIR/llama-cpp/llama-server"

# Windows: add .exe extension if needed
if [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]] || [[ -f "$SERVER.exe" ]]; then
  SERVER="$SERVER.exe"
fi

if [ ! -f "$MODEL" ]; then
  echo "Model not found: $MODEL"
  echo "Download it with:"
  echo "  curl -L https://huggingface.co/ggml-org/embeddinggemma-300M-GGUF/resolve/main/embeddinggemma-300M-Q8_0.gguf -o $MODEL"
  exit 1
fi

if [ ! -f "$SERVER" ]; then
  echo "llama-server not found: $SERVER"
  echo "Download from: https://github.com/ggml-org/llama.cpp/releases"
  exit 1
fi

echo "Starting embeddinggemma on port $PORT..."
echo "  Model: $MODEL"
echo "  Server: $SERVER"
echo ""
echo "Use with ctt-shell:"
echo "  EMBEDDING_PROVIDER=openai EMBEDDING_BASE_URL=http://localhost:$PORT node dist/src/cli/cli.js search <query>"
echo ""

exec "$SERVER" \
  --model "$MODEL" \
  --embedding \
  --port "$PORT" \
  --ctx-size 2048
