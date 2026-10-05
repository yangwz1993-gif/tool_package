#!/usr/bin/env python3
"""
hdo.py — handoff 方案文件维护工具（零三方库，Python 3.6+）

高频维护字段（todos/status/experience/repo_tree）的增删改查：
改完自动整体校验（不过不写盘）+ 自动重新生成 HTML（--no-gen 可关）。

流程图 nodes/edges、goal 等结构性低频改动：直接编辑 JSON，然后 `hdo <json> gen`。

用法：python3 hdo.py            （打印完整用法）
"""

import json
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SKILL_DIR))
GEN = SKILL_DIR / "gen_report.py"
TEMPLATE = SKILL_DIR / "模板.json"
PRIO = ("P0", "P1", "P2")
CMPLX = ("low", "mid", "high")

USAGE = """用法：
  hdo init <仓库目录> <项目名>          建 handoff/ + 生成 JSON 骨架
  hdo <json> show                       概览（节点/边/TODO/状态计数/阻塞与进行中清单）
  hdo <json> show goal|todo|status|exp|tree|nodes   只看某一板块（纯文本，适合贴给 agent）
  hdo <json> gen                        重新生成 HTML
  hdo <json> todo add --priority P0|P1|P2 --what .. --why .. --verify .. --complexity low|mid|high --risk .. [--deps ..]
  hdo <json> todo done <T编号> [备注]    完成：从 TODO 移除，记入「已完成」最前，并清掉同编号的进行中/阻塞
  hdo <json> todo abort <T编号> [备注]   中止：从 TODO 移除，记入「已中止」最前（忽略/改方向也用它）
  hdo <json> todo edit <T编号> [--priority ..] [--what ..] [--why ..] [--verify ..] [--complexity ..] [--risk ..] [--deps ..]
  hdo <json> todo rm <T编号>
  hdo <json> status doing <文本>         进行中置前（首词为 T编号 时替换同编号旧条目）
  hdo <json> status undoing <T编号>
  hdo <json> status block <文本>         加阻塞（同上替换逻辑）
  hdo <json> status unblock <T编号>
  hdo <json> status abort <文本>         加已中止（自由文本，替换逻辑同 doing）
  hdo <json> status unabort <T编号>
  hdo <json> exp add <文本>              经验沉淀追加
  hdo <json> tree set < 树形文件          刷新当前仓库结构（从标准输入读）
全局选项：--no-gen（本次改完不重新生成 HTML）
"""


def die(msg):
    print(f"❌ {msg}", file=sys.stderr)
    sys.exit(1)


def load(p: Path) -> dict:
    if not p.exists():
        die(f"找不到文件：{p}")
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        die(f"JSON 解析失败：{e}")


def save_and_gen(p: Path, d: dict, no_gen: bool, ok_msg: str):
    """整体校验（不过则退出、不写盘）→ 写盘 → 重新生成 HTML → 一行汇报"""
    import gen_report
    gen_report.validate(d)  # 校验失败内部 sys.exit，文件不会被写
    p.write_text(json.dumps(d, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if no_gen:
        print(f"✅ {ok_msg}（--no-gen，未重新生成）")
        return
    r = subprocess.run([sys.executable, str(GEN), str(p)], capture_output=True, text=True)
    if r.returncode != 0:
        err = (r.stderr.strip().splitlines() or ["未知错误"])[-1]
        print(f"✅ {ok_msg}｜⚠️ HTML 生成失败：{err}")
        sys.exit(1)
    out = (r.stdout.strip().splitlines() or [""])[-1]
    print(f"✅ {ok_msg}｜{out.replace('✅ 校验通过，已生成（复写）：', 'HTML → ')}")


def parse_flags(rest, allowed):
    out = {}
    i = 0
    while i < len(rest):
        a = rest[i]
        if not a.startswith("--"):
            die(f"无法识别的参数：{a}（选项应以 -- 开头）")
        k = a[2:]
        if k not in allowed:
            die(f"未知选项 --{k}（支持：{'、'.join('--' + x for x in allowed)}）")
        if i + 1 >= len(rest):
            die(f"--{k} 缺值")
        out[k] = rest[i + 1]
        i += 2
    return out


def find_todo(todos, tid):
    for t in todos:
        if t.get("id") == tid:
            return t
    die(f"找不到待办 {tid}（现有：{'、'.join(x.get('id', '?') for x in todos) or '无'}）")


# ---------- todo ----------

def cmd_todo(d, rest):
    if not rest:
        die("todo 子命令：add/done/edit/rm/abort")
    sub, rest = rest[0], rest[1:]
    todos = d.setdefault("todos", [])

    if sub == "add":
        req = ("priority", "what", "why", "verify", "complexity", "risk")
        f = parse_flags(rest, req + ("deps",))
        missing = [k for k in req if k not in f]
        if missing:
            die("todo add 缺必填项：" + "、".join("--" + k for k in missing) + "（todo 必须填写全）")
        if f["priority"] not in PRIO:
            die(f"priority 只能是 P0/P1/P2，当前：{f['priority']}")
        if f["complexity"] not in CMPLX:
            die(f"complexity 只能是 low/mid/high，当前：{f['complexity']}")
        nums = []
        for t in todos:
            m = re.fullmatch(r"T(\d+)[A-Za-z]?", t.get("id", ""))
            if m:
                nums.append(int(m.group(1)))
        new_id = f"T{(max(nums) if nums else 0) + 1}"
        todos.append({"id": new_id, "priority": f["priority"], "what": f["what"],
                      "why": f["why"], "verify": f["verify"], "complexity": f["complexity"],
                      "risk": f["risk"], "deps": f.get("deps") or "无"})
        return f"todo {new_id} 已添加（{f['priority']}/{f['complexity']}）"

    if sub in ("done", "edit", "rm", "abort"):
        if not rest:
            die(f"todo {sub} 缺 T编号")
        tid = rest[0]
        t = find_todo(todos, tid)

        if sub == "rm":
            d["todos"] = [x for x in todos if x.get("id") != tid]
            refs = [x["id"] for x in d["todos"] if tid in (x.get("deps") or "")]
            warn = f"｜⚠️ 注意：{'、'.join(refs)} 的 deps 还引用它" if refs else ""
            return f"todo {tid} 已删除{warn}"

        if sub == "edit":
            f = parse_flags(rest[1:], ("priority", "what", "why", "verify", "complexity", "risk", "deps"))
            if not f:
                die("todo edit 至少给一个选项")
            if "priority" in f and f["priority"] not in PRIO:
                die(f"priority 只能是 P0/P1/P2，当前：{f['priority']}")
            if "complexity" in f and f["complexity"] not in CMPLX:
                die(f"complexity 只能是 low/mid/high，当前：{f['complexity']}")
            t.update(f)
            return f"todo {tid} 已更新（{'、'.join(f)}）"

        # done / abort：从 TODO 移除，记入对应状态最前，并清掉同编号的进行中/阻塞
        note = " ".join(rest[1:]).strip()
        d["todos"] = [x for x in todos if x.get("id") != tid]
        st = d.setdefault("status", {})
        for k in ("doing", "blocked"):
            if st.get(k):
                st[k] = [x for x in st[k] if x.split(" ", 1)[0] != tid]
        key = "done" if sub == "done" else "aborted"
        lst = st.setdefault(key, [])
        line = f"{tid} {t['what']}" + (f"（{note}）" if note else "")
        lst.insert(0, line)
        label = "已完成" if sub == "done" else "已中止"
        return f"todo {tid} {label}，记入「{label}」最前"

    die(f"未知 todo 子命令：{sub}（add/done/edit/rm/abort）")


# ---------- status ----------

def cmd_status(d, rest):
    if not rest:
        die("status 子命令：doing/undoing/block/unblock/abort/unabort")
    sub = rest[0]
    st = d.setdefault("status", {})
    KEY = {"doing": "doing", "block": "blocked", "abort": "aborted",
           "undoing": "doing", "unblock": "blocked", "unabort": "aborted"}

    if sub in ("doing", "block", "abort"):
        text = " ".join(rest[1:]).strip()
        if not text:
            die(f"status {sub} 缺文本")
        key = KEY[sub]
        lst = st.setdefault(key, [])
        first = text.split(" ", 1)[0]
        if re.fullmatch(r"T\w+", first):
            lst[:] = [x for x in lst if x.split(" ", 1)[0] != first]
        lst.insert(0, text)
        return f"{key} 已更新（{len(lst)} 条）"

    if sub in ("undoing", "unblock", "unabort"):
        if len(rest) < 2:
            die(f"status {sub} 缺 T编号")
        tid = rest[1]
        key = KEY[sub]
        old = st.get(key, [])
        st[key] = [x for x in old if x.split(" ", 1)[0] != tid]
        if len(st[key]) == len(old):
            return f"{key} 里没有 {tid} 开头的条目（未改动）"
        return f"{key} 已移除 {tid}（剩 {len(st[key])} 条）"

    die(f"未知 status 子命令：{sub}（doing/undoing/block/unblock/abort/unabort）")


# ---------- experience / tree ----------

def cmd_exp(d, rest):
    if rest[:1] != ["add"]:
        die("exp 子命令：add <文本>")
    text = " ".join(rest[1:]).strip()
    if not text:
        die("exp add 缺文本")
    d.setdefault("experience", []).append(text)
    return f"经验已追加（共 {len(d['experience'])} 条）"


def cmd_tree(d, rest):
    if rest[:1] != ["set"]:
        die("tree 子命令：set < 树形文件（从标准输入读）")
    txt = sys.stdin.read()
    if not txt.strip():
        die("标准输入为空。用法：hdo <json> tree set < 树.txt　或　tree -L 2 | hdo <json> tree set")
    d["repo_tree"] = txt.strip("\n")
    return f"仓库结构已更新（{len(txt.strip().splitlines())} 行）"


# ---------- show / gen / init ----------

def cmd_show(d, rest):
    if rest:
        viewers = {"goal": show_goal, "todo": show_todo, "status": show_status,
                   "exp": show_exp, "tree": show_tree, "nodes": show_nodes}
        what = rest[0]
        if what not in viewers:
            die(f"show 板块只能是：{'/'.join(viewers)}（或不带参数看概览），当前：{what}")
        viewers[what](d)
        return
    nodes = d.get("nodes", [])
    edges = d.get("edges") or []
    todos = d.get("todos", [])
    pr = {p: sum(1 for t in todos if t.get("priority") == p) for p in PRIO}
    st = d.get("status") or {}
    edge_desc = str(len(edges)) if edges else "单链"
    print(f"{d.get('project', '?')}｜节点 {len(nodes)}｜边 {edge_desc}｜TODO {len(todos)}（P0×{pr['P0']} P1×{pr['P1']} P2×{pr['P2']}）")
    print(f"进行中 {len(st.get('doing') or [])}｜阻塞 {len(st.get('blocked') or [])}｜已完成 {len(st.get('done') or [])}｜已中止 {len(st.get('aborted') or [])}｜经验 {len(d.get('experience') or [])}")
    for b in (st.get("blocked") or []):
        print(f"  ⛔ {b}")
    for x in (st.get("doing") or []):
        print(f"  🔄 {x}")


def show_goal(d):
    g = d.get("goal", {})
    print(f"一句话目标：{g.get('one_liner', '（未填）')}")
    ms = g.get("metrics") or []
    print(f"指标（{len(ms)}）")
    for m in ms:
        print(f"  · {m['name']} → {m['target']}（{m['how']}）")


def show_todo(d):
    todos = d.get("todos", [])
    rank = {p: i for i, p in enumerate(PRIO)}
    todos = sorted(todos, key=lambda t: rank.get(t.get("priority"), 9))
    print(f"TODO（{len(todos)}，按优先级 P0→P2 排序）")
    for t in todos:
        print(f"[{t['id']}｜{t['priority']}｜{t['complexity']}] {t['what']}")
        print(f"  为什么：{t['why']}")
        print(f"  验证：{t['verify']}")
        print(f"  风险：{t['risk']}｜依赖：{t.get('deps') or '无'}")


def show_status(d):
    st = d.get("status") or {}
    if not any(st.get(k) for k in ("blocked", "doing", "done", "aborted")):
        print("（空，尚未开始执行）")
        return
    for key, title in (("doing", "🔄 进行中"), ("blocked", "⛔ 阻塞"),
                       ("done", "✅ 已完成"), ("aborted", "🛑 已中止")):
        items = st.get(key) or []
        print(f"{title}（{len(items)}）")
        for i, x in enumerate(items, 1):
            print(f"  {i}. {x}")


def show_exp(d):
    exp = d.get("experience") or []
    print(f"经验沉淀（{len(exp)}）")
    for i, x in enumerate(exp, 1):
        print(f"  {i}. {x}")


def show_tree(d):
    t = d.get("repo_tree") or ""
    print(t if t.strip() else "（未填写 repo_tree）")


def show_nodes(d):
    ns = d.get("nodes", [])
    print(f"节点（{len(ns)}）")
    for n in ns:
        print(f"[{n['id']}｜{n['complexity']}｜{n.get('type', 'process')}｜{n['stage']}] {n['name']}")
        print(f"  功能：{n['func']}")
        print(f"  风险：{n['risk']}")


def cmd_gen(p, no_gen):
    if no_gen:
        print("（--no-gen，跳过生成）")
        return
    r = subprocess.run([sys.executable, str(GEN), str(p)])
    sys.exit(r.returncode)


def cmd_init(rest):
    if len(rest) < 2:
        die("用法：hdo init <仓库目录> <项目名>")
    root, name = Path(rest[0]), rest[1]
    hd = root / "handoff"
    hd.mkdir(parents=True, exist_ok=True)
    day = datetime.now().strftime("%y%m%d")
    target = hd / f"{day}_{name}_方案.json"
    if target.exists():
        die(f"已存在：{target}（直接维护它即可）")
    if not TEMPLATE.exists():
        die(f"缺少模板：{TEMPLATE}")
    tpl = json.loads(TEMPLATE.read_text(encoding="utf-8"))
    tpl["project"] = name
    target.write_text(json.dumps(tpl, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"✅ 已创建 {target}")
    print("下一步：按 skill.md 字段规范把骨架改写成正式方案（初版手写），然后：")
    print(f"  python3 {SKILL_DIR}/hdo.py {target} gen")


# ---------- 主流程 ----------

def main():
    args = sys.argv[1:]
    no_gen = "--no-gen" in args
    args = [a for a in args if a != "--no-gen"]
    if not args or args[0] in ("-h", "--help", "help"):
        print(USAGE)
        return
    if args[0] == "init":
        cmd_init(args[1:])
        return
    if len(args) < 2:
        die(USAGE)
    p = Path(args[0])
    cmd, rest = args[1], args[2:]

    if cmd == "gen":
        load(p)
        cmd_gen(p, no_gen)
        return
    d = load(p)
    if cmd == "show":
        cmd_show(d, rest)
        return

    handlers = {"todo": cmd_todo, "status": cmd_status, "exp": cmd_exp, "tree": cmd_tree}
    if cmd not in handlers:
        die(f"未知命令：{cmd}\n\n{USAGE}")
    msg = handlers[cmd](d, rest)
    save_and_gen(p, d, no_gen, msg)


if __name__ == "__main__":
    main()
