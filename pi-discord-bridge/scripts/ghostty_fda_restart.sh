#!/bin/bash
# ==============================================================================
# ghostty_fda_restart.sh
#
# 目的：重启 Ghostty + herdr server，让 herdr 的「完全磁盘访问」生效，
#       并按快照恢复所有 Discord 房间（同名 agent + --session 续上原会话）。
#
# ⚠️ 关键前提：本脚本必须由 launchd 托管运行（launchctl submit），
#    否则它会挂在 herdr server 的进程树下，重启 server 时被一起杀掉。
#
# 日志：/tmp/ghostty_fda_restart.log
# 快照：/tmp/ghostty_fda_snapshot.json（执行前生成，脚本只读）
# 判据：sqlite3 TCC.db "select 1"  之前报 authorization denied，生效后应返回 1
# ==============================================================================
set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

LOG=/tmp/ghostty_fda_restart.log
LOCK=/tmp/ghostty_fda_restart.lock
SNAP=/tmp/ghostty_fda_snapshot.json
HERDR=/opt/homebrew/bin/herdr
BRIDGE_STATE="$HOME/.local/state/herdr/plugins/herdr.discord/state.json"
TCCDB="$HOME/Library/Application Support/com.apple.TCC/TCC.db"
GHOSTTY_PROC="Ghostty.app/Contents/MacOS/ghostty"
SERVER_PROC="/opt/homebrew/bin/herdr server"
BOT_PROC="herdr.discord.*src/bot"

# 全部输出进日志（launchd 托管的进程没有可用终端）
exec >>"$LOG" 2>&1

log(){  printf '[%s] %s\n' "$(date -u '+%H:%M:%SZ')" "$*"; }
step(){ printf '\n[%s] ======== %s ========\n' "$(date -u '+%H:%M:%SZ')" "$*"; }
probe(){ sqlite3 "$TCCDB" "select 1" 2>&1 | head -1; }
cnt(){ pgrep -f "$1" 2>/dev/null | wc -l | tr -d ' '; }
# ⚠️ 实测：pgrep -f 匹配不到 "/opt/homebrew/bin/herdr server"（明明存在却返 0）
#    所以 server 的存活一律用 herdr status / ps 判断，不靠 pgrep
server_pids(){ ps -axo pid=,command= | awk '/\/opt\/homebrew\/bin\/herdr server/ {print $1}' | tr '\n' ',' ; }
server_up(){ "$HERDR" status 2>/dev/null | grep -q 'status: running'; }
waitfor_up(){ # waitfor_up <名称> <次数> <间隔秒>
  local i
  for ((i=1;i<=$2;i++)); do
    server_up && { log "  ✓ $1 就绪（第 ${i} 次探测）"; return 0; }
    sleep "$3"
  done
  log "  ✗ $1 超时未就绪（等了 $2×$3 秒）"; return 1
}
waitfor(){ # waitfor <名称> <pgrep模式> <次数> <间隔秒>
  local i
  for ((i=1;i<=$3;i++)); do
    pgrep -f "$2" >/dev/null 2>&1 && { log "  ✓ $1 就绪（第 ${i} 次探测）"; return 0; }
    sleep "$4"
  done
  log "  ✗ $1 超时未就绪（等了 $3×$4 秒）"; return 1
}

# ── 防重入
if [ -f "$LOCK" ] && kill -0 "$(cat "$LOCK" 2>/dev/null)" 2>/dev/null; then
  log "已有实例在跑（PID $(cat "$LOCK")），本次退出"; exit 1
fi
echo $$ >"$LOCK"
trap 'rm -f "$LOCK"' EXIT

step "启动"
log "脚本 PID=$$  PPID=$PPID  父进程=$(ps -o command= -p "$PPID" 2>/dev/null | head -c 100)"
log "快照文件: $([ -f "$SNAP" ] && echo 存在 || echo '❌ 缺失')"
log "FDA 探测（改动前）: $(probe)"
[ -f "$SNAP" ] || { log "❌ 没有快照，拒绝继续（避免恢复不了）"; exit 1; }

# ── a. 让回复先发出去
step "a) sleep 5，等 sall 的回复先发出"
sleep 5

# ── 0. 备份
step "0) 备份桥状态与 herdr 布局"
ts=$(date +%Y%m%d_%H%M%S)
cp "$BRIDGE_STATE" "/tmp/bridge-state.$ts.json" 2>/dev/null && log "  ✓ 桥状态 → /tmp/bridge-state.$ts.json"
cp "$HOME/.config/herdr/session.json" "/tmp/herdr-session.$ts.json" 2>/dev/null && log "  ✓ herdr 布局 → /tmp/herdr-session.$ts.json"
cp "$SNAP" "/tmp/snapshot.$ts.json" 2>/dev/null && log "  ✓ 快照 → /tmp/snapshot.$ts.json"

# ── b. 完全退出 Ghostty
step "b) 完全退出 Ghostty"
log "  退出前 Ghostty 进程数: $(cnt "$GHOSTTY_PROC")"
osascript -e 'quit app "Ghostty"' 2>&1 | head -3
for i in $(seq 1 10); do pgrep -f "$GHOSTTY_PROC" >/dev/null 2>&1 || break; sleep 1; done
if pgrep -f "$GHOSTTY_PROC" >/dev/null 2>&1; then
  log "  仍在运行 → pkill 强退"
  pkill -f "$GHOSTTY_PROC"; sleep 3
fi
log "  退出后 Ghostty 进程数: $(cnt "$GHOSTTY_PROC")  （0 才算干净）"

# ── c. 重启 herdr server（这一步才是让 FDA 生效的关键）
step "c) 重启 herdr server"
log "  停止前 server PID: [$(server_pids)]  status: $("$HERDR" status 2>/dev/null | grep -c 'status: running')"
"$HERDR" server stop 2>&1 | head -3
for i in $(seq 1 15); do server_up || break; sleep 1; done
if server_up; then
  log "  server 未退 → kill"
  pkill -f "$SERVER_PROC"; sleep 3
fi
log "  停止后 server PID: [$(server_pids)]"

log "  拉起新 server"
nohup "$HERDR" server >/tmp/herdr-server-boot.log 2>&1 &
sleep 3
if waitfor_up "herdr server" 20 1; then
  log "  新 server PID: [$(server_pids)]"
else
  log "  ❌ 新 server 没起来！继续尝试，但后续大概率失败"
fi
log "  herdr status: $("$HERDR" status 2>&1 | tr '\n' ' ' | head -c 250)"

# ── c2. 桥是否自动回来（herdr.discord 是 enabled 插件，理论上自启）
step "c2) 等 Discord 桥自愈"
if waitfor "Discord 桥 bot" "$BOT_PROC" 30 2; then
  log "  ✓ 桥 PID=$(pgrep -f "$BOT_PROC" | tr '\n' ',')  —— Discord 控制权已恢复"
else
  log "  ❌ 桥没自动起来 → 尝试 disable/enable 插件循环"
  "$HERDR" plugin disable herdr.discord 2>&1 | head -3
  sleep 2
  "$HERDR" plugin enable herdr.discord 2>&1 | head -3
  if waitfor "Discord 桥 bot（二次）" "$BOT_PROC" 20 2; then
    log "  ✓ 二次拉起来了"
  else
    log "  ❌❌ 桥仍未起来 —— sall 将失去远程控制，请人工检查 herdr plugin list"
    "$HERDR" plugin list 2>&1 | head -6
  fi
fi

# ── d. 重开 Ghostty
step "d) 重开 Ghostty"
open -a Ghostty 2>&1 | head -3
sleep 6
log "  Ghostty 进程数: $(cnt "$GHOSTTY_PROC")"

# ── e. 按快照逐个恢复 agent
step "e) 按快照恢复 agent"

python3 - "$SNAP" "$HERDR" <<'PYEOF' > /tmp/restore_cmds.sh 2>>"$LOG"
import json, subprocess, sys
snap_path, herdr = sys.argv[1], sys.argv[2]
snap = json.load(open(snap_path))

def sh(c):
    return subprocess.run(c, shell=True, capture_output=True, text=True).stdout

# 重启后现存的 pane。用两种精确身份匹配，绝不靠编号猜：
#   ① pane_id 原样还在  ② agent_session 会话文件一致
# 注：herdr tab get 不返回 pane，别用 tab 推 pane（实测踩过）
panes, by_pane, by_sess, by_name = [], {}, {}, {}
try:
    panes = json.loads(sh(f"{herdr} pane list"))["result"]["panes"]
except Exception as e:
    print(f'echo "❌ pane list 失败: {e}" >>"$LOG"')
for p in panes:
    if p.get("pane_id"): by_pane[p["pane_id"]] = p
    v = (p.get("agent_session") or {}).get("value")
    if v: by_sess[v] = p
print(f'echo "[$(date -u +%H:%M:%SZ)] 重启后现存 pane 数: {len(panes)}" >>"$LOG"')
print()

for i, a in enumerate(snap["agents"]):
    name, cwd = a["agent_name"], a["cwd"]
    sess = a.get("session_file") or ""
    hit, how = by_pane.get(a["pane_id"]), "pane_id"
    if not hit and sess and sess in by_sess:
        hit, how = by_sess[sess], "会话文件"
    if hit:
        print(f'echo "[$(date -u +%H:%M:%SZ)] {name}: 复用 pane {hit["pane_id"]}（按{how}匹配）" >>"$LOG"')
        print(f'PANE_{i}="{hit["pane_id"]}"')
    else:
        print(f'echo "[$(date -u +%H:%M:%SZ)] {name}: 原 pane/会话都没命中 → 新建 workspace" >>"$LOG"')
        print(f'NEWWS_{i}=$("$HERDR" workspace create --cwd "{cwd}" --label "{name}" --no-focus 2>&1)')
        print(f'echo "$NEWWS_{i}" >>"$LOG"')
        print(f'PANE_{i}=$(printf \'%s\' "$NEWWS_{i}" | grep -oE \'w[0-9A-Za-z]+:p[0-9]+\' | head -1)')
    print(f'echo "[$(date -u +%H:%M:%SZ)]   → PANE_{i}=$PANE_{i}" >>"$LOG"')
    print()

print("# ---- 逐个启动 agent ----")
for i, a in enumerate(snap["agents"]):
    name = a["agent_name"]
    sess, model = a.get("session_file") or "", a.get("model") or ""
    mflag = f' --model "{model}"' if "/" in model else ""
    print(f'echo "[$(date -u +%H:%M:%SZ)] --- 恢复 {name} ---" >>"$LOG"')
    print(f'if [ -z "$PANE_{i}" ]; then echo "  ✗ PANE_{i} 为空，跳过 {name}" >>"$LOG"; else')
    print(f'  "$HERDR" agent start "{name}" --kind pi --pane "$PANE_{i}" -- --session "{sess}"{mflag} 2>&1 | head -3 >>"$LOG"')
    print(f'  sleep 4')
    print(f'  "$HERDR" agent get "{name}" 2>&1 | head -c 300 >>"$LOG"; echo >>"$LOG"')
    print(f'fi')
PYEOF

log "  生成的恢复命令（前 40 行）："
head -40 /tmp/restore_cmds.sh >>"$LOG" 2>&1

if bash -n /tmp/restore_cmds.sh; then
  log "  ✓ 恢复命令语法检查通过，开始执行"
  bash /tmp/restore_cmds.sh
  log "  恢复执行完毕"
else
  log "  ❌ 恢复命令语法错误，跳过执行"
fi

log "  恢复后 agent 列表: $("$HERDR" agent list 2>&1 | tr '\n' ' ' | head -c 600)"

# ── e2. 回写桥状态里的 pane_id（mid-turn 原样投递要用）
step "e2) 按最新 pane 回写桥状态"
python3 - "$SNAP" "$BRIDGE_STATE" "$HERDR" <<'PYEOF' >>"$LOG" 2>&1
import json, subprocess, sys
snap_path, state_path, herdr = sys.argv[1], sys.argv[2], sys.argv[3]
snap = json.load(open(snap_path))
def sh(c):
    return subprocess.run(c, shell=True, capture_output=True, text=True).stdout
alive = {}
try:
    for a in json.loads(sh(f"{herdr} agent list"))["result"]["agents"]:
        alive[a["name"]] = a
except Exception as e:
    print("agent list 失败:", e)
state = json.load(open(state_path))
changed = 0
for a in snap["agents"]:
    name, tid = a["agent_name"], a["thread_id"]
    cur = alive.get(name)
    if not cur:
        print(f"  {name}: 未恢复，跳过"); continue
    m = state["threads"].get(tid)
    if not m:
        print(f"  {name}: 桥里没这条 thread，跳过"); continue
    newp = cur["pane_id"]
    if m.get("pane_id") != newp:
        print(f"  {name}: pane {m.get('pane_id')} → {newp}")
        m["pane_id"] = newp
        changed += 1
state["threads"] = state["threads"]
json.dump(state, open(state_path, "w"), ensure_ascii=False, indent=2)
print(f"  共更新 {changed} 条映射")
PYEOF

# ── f. 让每个房间自报「已重启恢复」
step "f) 通知各房间报到"
python3 - "$SNAP" "$HERDR" <<'PYEOF' >>"$LOG" 2>&1
import json, subprocess, sys, time
snap_path, herdr = sys.argv[1], sys.argv[2]
snap = json.load(open(snap_path))
msg = "【系统消息】herdr 已因「完全磁盘访问」生效而重启。你所在的房间已自动恢复，请用一句话向 sall 确认：已重启恢复，会话上下文完好。"
for a in snap["agents"]:
    name = a["agent_name"]
    r = subprocess.run([herdr, "agent", "prompt", name, msg],
                       capture_output=True, text=True)
    print(f"  prompt {name}: rc={r.returncode} {r.stdout.strip()[:120]} {r.stderr.strip()[:120]}")
    time.sleep(2)
PYEOF

# ── g. FDA 是否生效
step "g) 最终判据：完全磁盘访问是否生效"
sleep 4
RESULT=$(probe)
log "  sqlite3 TCC.db 'select 1' → $RESULT"
if printf '%s' "$RESULT" | grep -q '^1$'; then
  log "  ✅✅ 完全磁盘访问已生效"
else
  log "  ❌ 仍未生效（仍是 authorization denied）→ 可能是授权路径与 herdr 真实路径不一致"
  log "     herdr 真实路径: $(readlink -f "$HERDR" 2>/dev/null || echo "?")"
  log "     请检查 系统设置→隐私与安全性→完全磁盘访问 里那条的路径"
fi

step "结束"
log "重启+恢复流程跑完。sall 可在 Discord 里让各房间确认。"
