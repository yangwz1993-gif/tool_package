#!/bin/bash
# status.sh —— 一眼看清飞书这条链路的当前状态
#
# 用法：./status.sh          （只看状态）
#       ./status.sh --tail   （顺便把面板最后 20 行也打出来）

set -uo pipefail

HERDR_BIN="${HERDR_BIN:-$HOME/homebrew/bin/herdr}"
SESSION="${LARK_HERDR_SESSION:-lark-local}"
PROJECT="${LARK_PROJECT:-$HOME/Documents/workspace}"
STATE="$PROJECT/.pi/lark-bot"
INSTALL="$HOME/.pi/agent/git/github.com/fyang93/pi-lark-bot"

line() { printf '  %-22s %s\n' "$1" "$2"; }

echo "=== herdr 会话 ==="
if "$HERDR_BIN" session list 2>/dev/null | grep -q "^\s*$SESSION"; then
  line "会话 $SESSION" "运行中"
else
  line "会话 $SESSION" "未运行（用 herdr-lark-launch.sh 拉起）"
fi

echo
echo "=== 附加的客户端（没有的话 pane 只有 80x40，长内容会被裁）==="
if ps -eo command 2>/dev/null | grep -qE "[h]erdr --session ${SESSION}$"; then
  line "客户端" "已附着 ✓"
else
  line "客户端" "没有 ✗ —— 二维码/链接会显示不全"
fi

echo
echo "=== 面板里的 agent ==="
"$HERDR_BIN" --session "$SESSION" agent list 2>/dev/null | python3 -c "
import sys,json
try:
    for a in json.load(sys.stdin)['result']['agents']:
        print(f\"  {a['name']:<22} {a['pane_id']:<8} {a['agent_status']}\")
except Exception as e:
    print('  读取失败（会话没起？）:', e)
" 2>&1

echo
echo "=== 凭据与白名单 (${STATE}) ==="
for f in config.json allowlist.json enabled.json; do
  if [ -f "$STATE/$f" ]; then
    python3 -c "
import json
d=json.load(open('$STATE/$f'))
def redact(o):
    if isinstance(o,dict): return {k:(('***' if 'ecret' in k else v) if not isinstance(v,(dict,list)) else redact(v)) for k,v in o.items()}
    if isinstance(o,list): return [redact(x) for x in o]
    return o
print('  $f:', json.dumps(redact(d),ensure_ascii=False))
" 2>/dev/null || line "$f" "(读取失败)"
  else
    line "$f" "不存在"
  fi
done

echo
echo "=== 安装位置是否有本地改动 ==="
if [ -d "$INSTALL/.git" ]; then
  n=$(git -C "$INSTALL" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  v=$(python3 -c "import json;print(json.load(open('$INSTALL/package.json'))['version'])" 2>/dev/null)
  line "版本" "$v"
  line "未提交改动" "$n 处"
  [ "$n" != "0" ] && git -C "$INSTALL" diff --stat 2>/dev/null | sed 's/^/    /'
else
  line "安装位置" "不是 git 仓库或不存在"
fi

if [ "${1:-}" = "--tail" ]; then
  echo
  echo "=== 面板最后 20 行 ==="
  PANE=$("$HERDR_BIN" --session "$SESSION" agent list 2>/dev/null | python3 -c "
import sys,json
try:
    for a in json.load(sys.stdin)['result']['agents']:
        if a['name']=='lark': print(a['pane_id']); break
except Exception: pass
" 2>/dev/null)
  [ -n "$PANE" ] && "$HERDR_BIN" --session "$SESSION" pane read --source recent --lines 300 "$PANE" 2>&1 | tail -20 | sed 's/^/  /'
fi
