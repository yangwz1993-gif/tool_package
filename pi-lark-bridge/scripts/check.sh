#!/bin/bash
# check.sh —— 部署前的闸门：类型检查 + 单元测试（都跑在 source/ 里）
#
# 为什么必须有这个脚本：
#   踩过一次。表情回应那 26 行改动里，常量 ACK_EMOJI 的 edit 被报错拒绝了，谁都没发现，
#   `tsc` 又从来没跑过（本地没装 tsc）。于是运行时每次收信都在那一行抛
#   ReferenceError：消息能收进来、✅ 贴不出来、回复一条也没有，界面上只有一句
#   不带细节的「Lark bot operation failed」。这类错误静态一查就现形。
#
# 用法：
#   ./check.sh          # 类型检查 + 测试
#   ./check.sh --fast   # 只做类型检查
#
# 依赖：source/node_modules（没有就先 npm install，脚本会自己装）

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$HERE/source"

[ -d "$SOURCE/src" ] || { echo "找不到源码目录: $SOURCE/src" >&2; exit 1; }
cd "$SOURCE"

if [ ! -x node_modules/.bin/tsc ]; then
  echo "=== 安装依赖（首次）==="
  npm install --no-audit --no-fund || { echo "npm install 失败" >&2; exit 1; }
  echo
fi

echo "=== 类型检查 ==="
if ./node_modules/.bin/tsc --noEmit; then
  echo "  ✓ 没有类型错误"
else
  echo "  ✗ 类型检查失败 —— 先修完再部署" >&2
  exit 1
fi

if [ "${1:-}" = "--fast" ]; then exit 0; fi

echo
echo "=== 单元测试 ==="
OUT="$(./node_modules/.bin/tsx --test --test-concurrency=1 --test-timeout=30000 test/*.test.ts 2>&1)"
echo "$OUT" | grep -E "^# (tests|pass|fail)" | sed 's/^/  /'
echo "$OUT" | grep -E "^not ok" | sed 's/^/  /'
if echo "$OUT" | grep -qE "^not ok"; then
  echo "  ✗ 有测试失败 —— 先修完再部署" >&2
  exit 1
fi
echo "  ✓ 全部通过"
