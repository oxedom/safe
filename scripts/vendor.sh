#!/usr/bin/env bash
# Copies the runtime dependencies into extension/ so the unpacked extension
# is fully self-contained (MV3 forbids remotely hosted code).
#
#   extension/vendor/tf.es2017.min.js          TF.js 4.22 (core + webgl + cpu), ES2017 build:
#                                              the ES5 build evals (regenerator-runtime) and MV3 CSP blocks it
#   extension/vendor/tf-backend-webgpu.es2017.min.js  optional WebGPU backend
#   extension/models/yolov7/                   YOLOv7 graph model (model.json + 6 shards)
#
# Downloads a pinned model revision, or uses SAFE_MODEL_DIR when explicitly set.
# Runtime assets retain their upstream licenses; see THIRD_PARTY_NOTICES.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT="$ROOT/extension"

if [ ! -d "$ROOT/node_modules/@tensorflow/tfjs" ] || [ ! -d "$ROOT/node_modules/@tensorflow/tfjs-backend-webgpu" ]; then
  (cd "$ROOT" && pnpm install --frozen-lockfile)
fi

mkdir -p "$EXT/vendor" "$EXT/models/yolov7"
cp "$ROOT/node_modules/@tensorflow/tfjs/dist/tf.es2017.min.js" "$EXT/vendor/"
cp "$ROOT/node_modules/@tensorflow/tfjs-backend-webgpu/dist/tf-backend-webgpu.es2017.min.js" "$EXT/vendor/"

MODEL_REV="3a5510ab36a8252ceaa82c3dcd95572bc253902a"
MODEL_SRC="${SAFE_MODEL_DIR:-}"
MODEL_DST="$EXT/models/yolov7"
if [ -n "$MODEL_SRC" ]; then
  cp "$MODEL_SRC"/model.json "$MODEL_SRC"/group1-shard*of6.bin "$MODEL_DST/"
else
  BASE="https://raw.githubusercontent.com/oxedom/parker/$MODEL_REV/client/public/yolov7_web_model"
  for f in model.json group1-shard{1..6}of6.bin; do
    curl -fsSL --retry 3 -o "$MODEL_DST/$f" "$BASE/$f"
  done
fi

cp "$ROOT/LICENSE" "$EXT/LICENSE.txt"
cp "$ROOT/THIRD_PARTY_NOTICES.md" "$EXT/"
curl -fsSL --retry 3 https://raw.githubusercontent.com/tensorflow/tfjs/tfjs-v4.22.0/LICENSE -o "$EXT/vendor/LICENSE-Apache-2.0.txt"
curl -fsSL --retry 3 "https://raw.githubusercontent.com/oxedom/parker/$MODEL_REV/LICENSE.txt" -o "$MODEL_DST/LICENSE-Parker.txt"
curl -fsSL --retry 3 https://raw.githubusercontent.com/WongKinYiu/yolov7/main/LICENSE.md -o "$MODEL_DST/LICENSE-YOLOv7-GPL-3.0.txt"

echo "vendored:"
du -sh "$EXT/vendor" "$EXT/models/yolov7"
