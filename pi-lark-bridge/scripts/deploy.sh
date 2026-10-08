#!/bin/bash
# deploy.sh —— 把 pi-lark-bridge/source/ 同步到 pi 的扩展安装位置
#
# 背景：pi-lark-bot 是第三方扩展，由 `pi install git:github.com/fyang93/pi-lark-bot`
# 装到 ~/.pi/agent/git/github.com/fyang93/pi-lark-bot。
# 我们在本仓库的 source/ 里维护改动过的版本，这个脚本负责把它推上去，
# 顺便把「我们与上游的全部差异」重新导出成 extensions/ 里的 patch。
#
# 用法：
#   ./deploy.sh                 # 先跑类型检查+测试，再预览要改什么（dry-run，默认）
#   ./deploy.sh --go            # 真正同步（同样先过检查）
#   ./deploy.sh --go --skip-check   # 跳过检查，只在明确知道为什么时用
#   ./deploy.sh --restore       # 从上游重新克隆，丢弃本地改动（危险）

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$HERE/source"
TARGET="$HOME/.pi/agent/git/github.com/fyang93/pi-lark-bot"
UPSTREAM="https://github.com/fyang93/pi-lark-bot.git"
PATCH="$HERE/extensions/pi-lark-bridge.patch"
BASED_ON="$HERE/extensions/based-on.txt"

MODE="dry-run"
CHECK="run"
for arg in "$@"; do
  case "$arg" in
    --go)           MODE="REAL" ;;
    --restore)      MODE="RESTORE" ;;
    --skip-check)   CHECK="skip" ;;
    "")             ;;
    *) echo "未知参数: $arg" >&2; exit 2 ;;
  esac
done

if [ "$MODE" = "RESTORE" ]; then
  echo "这会删掉 $TARGET 并从上游重新克隆。"
  echo "确认请手动执行："
  echo "  rm -rf '$TARGET' && git clone '$UPSTREAM' '$TARGET'"
  echo "然后重新跑本脚本 --go 把 source/ 的改动打回去。"
  exit 0
fi

[ -d "$SOURCE/src" ] || { echo "找不到源码目录: $SOURCE/src" >&2; exit 1; }
if [ ! -d "$TARGET" ]; then
  echo "目标不存在，先安装扩展：" >&2
  echo "  pi install git:github.com/fyang93/pi-lark-bot" >&2
  exit 1
fi

echo "=========================================="
echo " 模式 : $MODE"
echo " 来源 : $SOURCE"
echo " 目标 : $TARGET"
echo "=========================================="
echo

# 部署过的代码没跑过类型检查，已经害过一次：一个未定义的常量让每次收信都抛
# ReferenceError，消息照收、回复一条没有。所以检查默认开着，失败就不部署。
if [ "$CHECK" = "run" ]; then
  "$HERE/scripts/check.sh" || { echo "检查没过，未部署。确需强行部署加 --skip-check。" >&2; exit 1; }
  echo
fi

OPTS=(-a --delete --exclude='node_modules/' --exclude='.git/')
# 没有 -v，rsync（macOS 自带的 openrsync）在 -n 下一个字都不打印，dry-run 会假装「没差异」。
[ "$MODE" = "dry-run" ] && OPTS+=(-n -i)

echo "### 同步 src/ ###"
rsync "${OPTS[@]}" "$SOURCE/src/" "$TARGET/src/"

echo
echo "### 同步包元信息 ###"
for f in package.json tsconfig.json LICENSE README.md; do
  [ -f "$SOURCE/$f" ] || continue
  rsync "${OPTS[@]}" "$SOURCE/$f" "$TARGET/$f"
done

echo
if [ "$MODE" = "dry-run" ]; then
  echo "以上是 dry-run，什么都没改。确认后执行： $0 --go"
else
  echo "### 导出 patch（我们与上游的全部差异）###"
  git -C "$TARGET" rev-parse HEAD > "$BASED_ON"
  git -C "$TARGET" diff > "$PATCH"
  echo "  $(basename "$PATCH"): $(wc -l < "$PATCH" | tr -d ' ') 行，基线 $(cut -c1-8 "$BASED_ON")"
  git -C "$TARGET" diff --stat | tail -1 | sed 's/^/  /'

  echo
  echo "同步完成。"
  echo
  echo "接下来重启监听（在 pi 里）："
  echo "  /lark-bot off   →   /reload   →   /lark-bot on"
  echo
  echo "重启后自检（在本目录）："
  echo "  ./scripts/status.sh --tail"
  echo
  echo "改动摘要（源码 vs 安装位置）："
  diff -rq "$SOURCE/src" "$TARGET/src" 2>&1 | head -10 | sed 's/^/  /'
fi
