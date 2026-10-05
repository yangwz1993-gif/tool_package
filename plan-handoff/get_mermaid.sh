#!/bin/sh
# 下载 mermaid 渲染引擎到本脚本所在目录（gen_report.py 生成单文件离线报告时要用）。
# 用途：不想把 3.2MB 的 mermaid.min.js 放进仓库时，克隆后先跑一次这个脚本。
set -e

DIR=$(cd "$(dirname "$0")" && pwd)
OUT="$DIR/mermaid.min.js"
URL="https://cdn.jsdelivr.net/npm/mermaid@10.9.8/dist/mermaid.min.js"
FALLBACK="https://unpkg.com/mermaid@10.9.8/dist/mermaid.min.js"

if [ -s "$OUT" ]; then
  echo "✅ 已存在，跳过：$OUT"
  exit 0
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "❌ 没找到 curl，请手动下载：$URL" >&2
  echo "   存到：$OUT" >&2
  exit 1
fi

curl -fsSL -o "$OUT" "$URL" || curl -fsSL -o "$OUT" "$FALLBACK" || {
  echo "❌ 下载失败（没网 / 被墙 / CDN 不通）。手动下载后放到：$OUT" >&2
  echo "   地址：$URL" >&2
  exit 1
}

echo "✅ 已下载到 $OUT"
