#!/usr/bin/env python3
"""
gen_report.py — 方案报告生成器（零三方库，Python 3.6+）

输入：JSON（字段规范见同目录 skill.md）
输出：HTML 单文件 {项目}_方案报告.html（内嵌 mermaid.min.js，离线可看，可转发）
      固定文件名、每次复写，只留最新（HTML 是视图，随时可由 JSON 重新生成）；
      加 --keep 时额外留一份时间戳快照（大改版前留底用）。

用法：python3 gen_report.py 输入.json [--keep]

分工：日常维护（todos/status/experience/repo_tree 的增删改）一律用 hdo.py，
改完自动调本脚本重新生成；流程图 nodes/edges、goal 等结构性低频改动可直接编辑 JSON，
改完运行本脚本（或 hdo gen）。
"""

import json
import os
import re
import sys
import html as html_mod
import unicodedata
from datetime import datetime
from pathlib import Path

EMOJI = {"low": "🟢", "mid": "🟡", "high": "🔴"}
LABEL = {"low": "低", "mid": "中", "high": "高"}
PRIO = ("P0", "P1", "P2")  # todo 优先级：P0 紧急 / P1 高 / P2 普通
# 节点类型 → mermaid 形状模板（形状表达类型，颜色仍由复杂度决定）
SHAPES = {
    "process":    '{id}["{label}"]',      # 处理（默认矩形）
    "start":      '{id}("{label}")',      # 开始（圆头）
    "end":        '{id}("{label}")',      # 结束/产出（圆头）
    "decision":   '{id}{{"{label}"}}',    # 判断/分支（菱形）
    "loop":       '{id}["{label}"]',      # 循环/回流（矩形 + 虚线粗边框，见 *Dash 样式）
    "io":         '{id}[/"{label}"/]',    # 输入/输出（平行四边形）
    "data":       '{id}[("{label}")]',    # 数据存储（圆柱）
    "subprocess": '{id}[["{label}"]]',    # 子流程（双边矩形）
}
SCRIPT_DIR = Path(__file__).resolve().parent
# mermaid 渲染引擎：默认用同目录的 mermaid.min.js；也可用环境变量 HANDOFF_MERMAID
# 指向别处的副本（多个项目共用一份，不必每个目录都放 3.2MB）
MERMAID_JS = Path(
    os.environ.get("HANDOFF_MERMAID") or (SCRIPT_DIR / "mermaid.min.js")
).expanduser()


# ---------- 显示宽度（仅 ASCII 备用图用） ----------

def dw(s: str) -> int:
    w = 0
    for c in s:
        if unicodedata.category(c) in ("Mn", "Cf"):
            continue
        if ord(c) >= 0x1F300 or unicodedata.east_asian_width(c) in ("W", "F"):
            w += 2
        else:
            w += 1
    return w



# ---------- JSON 校验 ----------

def fail(msg: str):
    print(f"❌ JSON 校验失败：{msg}", file=sys.stderr)
    sys.exit(1)


def parse_edge(e, i):
    """边支持两种写法：['N1','N2'] 或 {'from':'N1','to':'N2','label':'可选文字'}"""
    if isinstance(e, dict):
        f, t, lab = e.get("from"), e.get("to"), e.get("label")
    elif isinstance(e, list) and len(e) in (2, 3):
        f, t = e[0], e[1]
        lab = e[2] if len(e) == 3 else None
    else:
        fail(f"edges[{i}] 格式错误：应为 [from, to] 或 {{'from','to','label'}}")
    if not f or not t:
        fail(f"edges[{i}] 缺少 from/to")
    if lab and re.search(r'[<>"\\|]', str(lab)):
        fail(f"edges[{i}] 的 label 含特殊字符 < > \" \\ |")
    return f, t, lab


def validate(d: dict):
    if not isinstance(d, dict):
        fail("顶层必须是 JSON 对象")
    if "steps" in d:
        fail("「steps」字段已废弃：第 4 节改为「当前TODO」，请改名 todos；列：做什么/为什么做这件事/验证方法/复杂度/风险/依赖")
    for k in ("project", "goal", "nodes", "todos"):
        if k not in d:
            fail(f"缺少顶层字段「{k}」")
    if not isinstance(d["project"], str) or not d["project"].strip():
        fail("project 必须是非空字符串（报告标题与 HTML 文件名都取自它）")
    if re.search(r'[\\/]', d["project"]) or any(unicodedata.category(c) == "Cc" for c in d["project"]):
        fail(f"project 名「{d['project']}」不能含路径分隔符 / \\ 或换行等控制字符（它是 HTML 文件名的来源）")
    g = d["goal"]
    if "one_liner" not in g:
        fail("goal.one_liner 缺失")
    for i, m in enumerate(g.get("metrics", [])):
        for k in ("name", "target", "how"):
            if k not in m:
                fail(f"goal.metrics[{i}] 缺少「{k}」")

    if not d["nodes"]:
        fail("nodes 不能为空")
    ids = set()
    for i, n in enumerate(d["nodes"]):
        for k in ("id", "name", "stage", "complexity", "func", "risk"):
            if k not in n:
                fail(f"nodes[{i}] 缺少「{k}」")
        if n["id"] in ids:
            fail(f"节点 id 重复：{n['id']}")
        ids.add(n["id"])
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", n["id"]):
            fail(f"节点 id「{n['id']}」只能以字母开头、由字母数字下划线组成（mermaid 语法要求）")
        if n["complexity"] not in EMOJI:
            fail(f"{n['id']} 的 complexity 只能是 low/mid/high，当前：{n['complexity']}")
        ntype = n.get("type", "process")
        if ntype not in SHAPES:
            fail(f"{n['id']} 的 type 只能是 {'/'.join(SHAPES)}，当前：{ntype}")
        if ntype == "decision" and not d.get("edges"):
            fail(f"判断节点「{n['id']}」只用于 DAG 模式（需写 edges 分支）；单链流程请用 process")
        if len(n["name"]) > 10:
            print(f"⚠️  {n['id']} 的节点名称「{n['name']}」{len(n['name'])} 字偏长：图上建议≤10字，细节请放 note/func", file=sys.stderr)
        note = n.get("note", [])
        if isinstance(note, str):
            note = [note]
        if not isinstance(note, list):
            fail(f"{n['id']} 的 note 必须是字符串或字符串数组")
        for field, val in [("name", n["name"]), ("stage", n["stage"])] + \
                          [("note", x) for x in note]:
            if re.search(r'[<>"\\()/]', val):
                fail(f"{n['id']} 的 {field} 含半角特殊字符 < > \" \\ ( ) /（会破坏图渲染，请改用全角或改写）")
        code = n.get("code")
        if code is not None:
            items = [code] if isinstance(code, str) else code
            if not isinstance(items, list) or not all(isinstance(x, str) for x in items):
                fail(f"{n['id']} 的 code 必须是字符串或字符串数组")
            for x in items:
                if "|" in x or "\n" in x:
                    fail(f"{n['id']} 的 code 条目不能含 | 或换行（会破坏表格）")

    # todos 允许为空：项目收尾时所有待办都已销账，报告第 4 节会显示「（无待办）」占位
    tids = set()
    for i, t in enumerate(d["todos"]):
        for k in ("id", "priority", "what", "why", "verify", "complexity", "risk"):
            if k not in t:
                fail(f"todos[{i}] 缺少「{k}」")
        if not isinstance(t["id"], str) or not t["id"].strip():
            fail(f"todos[{i}] 的 id 必须是非空字符串")
        if t["id"] in tids:
            fail(f"待办 id 重复：{t['id']}（销账与排序会产生歧义，请改成唯一编号）")
        tids.add(t["id"])
        if t["complexity"] not in EMOJI:
            fail(f"{t['id']} 的 complexity 只能是 low/mid/high")
        if t["priority"] not in PRIO:
            fail(f"{t['id']} 的 priority 只能是 P0/P1/P2，当前：{t['priority']}")
    # 可选：当前状态 / 经验沉淀 / 仓库结构
    st = d.get("status")
    if st is not None:
        if not isinstance(st, dict) or any(k not in ("done", "doing", "blocked", "aborted") for k in st):
            fail("status 只能是 {'done': [...], 'doing': [...], 'blocked': [...], 'aborted': [...]} 结构")
        for k, v in st.items():
            if not isinstance(v, list) or not all(isinstance(x, str) for x in v):
                fail(f"status.{k} 必须是字符串数组")
    exp = d.get("experience")
    if exp is not None and (not isinstance(exp, list) or not all(isinstance(x, str) for x in exp)):
        fail("experience 必须是字符串数组")
    if "repo_tree" in d and not isinstance(d["repo_tree"], str):
        fail("repo_tree 必须是字符串（ASCII 树形文本）")

    edges = d.get("edges")
    if edges is not None:
        if not isinstance(edges, list) or not edges:
            fail("edges 必须是非空数组；不需要自定义连线就删掉这个字段（默认顺序单链）")
        parsed = [parse_edge(e, i) for i, e in enumerate(edges)]
        seen, used = set(), set()
        for i, (f, t, _lab) in enumerate(parsed):
            for ref in (f, t):
                if ref not in ids:
                    fail(f"edges[{i}] 引用了不存在的节点「{ref}」")
            if f == t:
                fail(f"edges[{i}] 是自环（{f} → {t}），不允许；循环依赖请画到上游节点")
            if (f, t) in seen:
                fail(f"edges[{i}] 与前面的边重复（{f} → {t}）")
            seen.add((f, t))
            used.update((f, t))
        lonely = ids - used
        if lonely:
            fail(f"节点 {sorted(lonely)} 没有连任何边（DAG 模式下每个节点至少要连一条边）")
        # 判断节点的结构校验：≥2 条出边且每条必须带 label
        for n in d["nodes"]:
            if n.get("type") == "decision":
                outs = [(t, lab) for (f, t, lab) in parsed if f == n["id"]]
                if len(outs) < 2:
                    fail(f"判断节点「{n['id']}」至少需要 2 条出边（当前 {len(outs)} 条），否则不成其为判断")
                for (t, lab) in outs:
                    if not lab:
                        fail(f"判断节点「{n['id']}」→「{t}」的出边必须写 label（如 合格/不合格）")


def node_code(n) -> list:
    """节点的相关代码，归一化为列表；没填返回空列表"""
    code = n.get("code")
    if not code:
        return []
    return [code] if isinstance(code, str) else list(code)


# ---------- Mermaid 代码生成 ----------

def gen_mermaid(d: dict) -> str:
    nodes = d["nodes"]
    lines = ["flowchart LR"]

    # 相邻同 stage 的节点归入一个 subgraph（阶段分组）
    groups = []
    for n in nodes:
        if not groups or groups[-1][0] != n["stage"]:
            groups.append((n["stage"], []))
        groups[-1][1].append(n)

    # mermaid LR 布局：先声明的分组被排在下方。反转声明顺序，流程才能从左上走向右下
    for gi, (stage, ns) in reversed(list(enumerate(groups, 1))):
        lines.append(f'  subgraph SG{gi}["{stage}"]')
        lines.append("    direction TB")  # 整体 LR：阶段从左到右，阶段内节点竖排
        for n in ns:
            # 图上只放短名称（emoji + id + name）；备注不进图，点击节点弹窗展示
            label = f"{EMOJI[n['complexity']]} {n['id']} · {n['name']}"
            lines.append("    " + SHAPES[n.get("type", "process")].format(id=n["id"], label=label))
        lines.append("  end")

    if d.get("edges"):
        for i, e in enumerate(d["edges"]):
            f, t, lab = parse_edge(e, i)
            lines.append(f"  {f} -->|{lab}| {t}" if lab else f"  {f} --> {t}")
    else:
        for a, b in zip(nodes, nodes[1:]):
            lines.append(f"  {a['id']} --> {b['id']}")

    lines += [
        "  classDef low fill:#e6f6e6,stroke:#1a7f1a,color:#14532d,stroke-width:1.5px",
        "  classDef mid fill:#fdf3d7,stroke:#b45309,color:#713f12,stroke-width:1.5px",
        "  classDef high fill:#fde2e2,stroke:#c0392b,color:#7f1d1d,stroke-width:1.5px",
        # 循环/回流节点：同色系但虚线粗边框
        "  classDef lowDash fill:#e6f6e6,stroke:#1a7f1a,color:#14532d,stroke-width:2.5px,stroke-dasharray:6 4",
        "  classDef midDash fill:#fdf3d7,stroke:#b45309,color:#713f12,stroke-width:2.5px,stroke-dasharray:6 4",
        "  classDef highDash fill:#fde2e2,stroke:#c0392b,color:#7f1d1d,stroke-width:2.5px,stroke-dasharray:6 4",
    ]
    by_level = {"low": [], "mid": [], "high": []}
    for n in nodes:
        suffix = "Dash" if n.get("type") == "loop" else ""
        by_level[n["complexity"]].append((n["id"], suffix))
    for level, items in by_level.items():
        plain = [i for i, s in items if not s]
        dash = [i for i, s in items if s]
        if plain:
            lines.append(f"  class {','.join(plain)} {level}")
        if dash:
            lines.append(f"  class {','.join(dash)} {level}Dash")
    # 阶段分组框调成中性灰，避免和黄/红色节点语义混淆
    for gi in range(1, len(groups) + 1):
        lines.append(f"  style SG{gi} fill:#f8fafc,stroke:#94a3b8,color:#334155")
    return "\n".join(lines)


# ---------- HTML 渲染 ----------

HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__PROJECT__ · 方案报告</title>
<style>
  body { font-family: -apple-system, "PingFang SC", sans-serif; max-width: 960px;
         margin: 32px auto; padding: 0 16px; color: #222; }
  .meta { color: #888; font-size: 13px; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  h2 { font-size: 17px; border-left: 4px solid #4a7ddb; padding-left: 8px; margin-top: 32px; }
  .goal { background: #f0f6ff; border: 1px solid #d3e3ff; border-radius: 8px;
          padding: 12px 16px; margin-bottom: 12px; }
  table { border-collapse: collapse; width: 100%; margin: 8px 0 16px; }
  th, td { border: 1px solid #ddd; padding: 6px 10px; font-size: 14px;
           text-align: left; vertical-align: top; }
  th { background: #f0f0f4; }
  /* TODO 表：固定布局，三列长文本等宽放宽，风险/依赖等宽略窄 */
  table.todo-table { table-layout: fixed; }
  table.todo-table td { word-break: break-word; }
  table.todo-table col.c-id     { width: 5%; }
  table.todo-table col.c-prio   { width: 6.5%; }
  table.todo-table col.c-text   { width: 19%; }   /* 做什么/为什么做/验证方法 */
  table.todo-table col.c-cmplx  { width: 7.5%; }
  table.todo-table col.c-narrow { width: 12.5%; } /* 风险/依赖 */
  td code { font-family: Menlo, monospace; font-size: 12px; background: #f0f0f4;
            padding: 1px 4px; border-radius: 3px; white-space: nowrap; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 10px;
           font-size: 12px; font-weight: 600; white-space: nowrap; }
  .low  { background: #e6f6e6; color: #1a7f1a; }
  .mid  { background: #fdf3d7; color: #9a6a00; }
  .high { background: #fde2e2; color: #c0392b; }
  .legend { font-size: 13px; color: #666; margin-bottom: 8px; }
  .muted { color: #999; font-size: 13px; }
  details.fold { margin: 10px 0 18px; }
  details.fold > summary { cursor: pointer; font-size: 14px; font-weight: 600;
                           color: #4a7ddb; padding: 6px 0; user-select: none; }
  details.fold > summary:hover { text-decoration: underline; }
  .badge.p0 { background: #dc2626; color: #fff; }
  .badge.p1 { background: #ea580c; color: #fff; }
  .badge.p2 { background: #64748b; color: #fff; }
  .exp ul { margin: 4px 0 12px; padding-left: 22px; }
  .exp li { font-size: 14px; margin: 2px 0; }
  /* 当前状态：4列2行（进行中/阻塞/已完成/已中止） */
  table.status-table { table-layout: fixed; }
  table.status-table th, table.status-table td { width: 25%; vertical-align: top; }
  table.status-table ul { margin: 0; padding-left: 18px; }
  table.status-table li { font-size: 13px; margin: 2px 0; }
  .hist-btn { border: 1px solid #d0d0d8; background: #fff; border-radius: 6px;
              padding: 2px 10px; cursor: pointer; font-size: 12px; margin-top: 6px;
              color: #4a7ddb; }
  .hist-btn:hover { background: #f0f0f4; }
  .hist-store { display: none; }
  /* ASCII 树：固定格渲染，任何字体下都对齐 */
  .agrid { font-family: Menlo, Monaco, monospace; font-size: 13px; line-height: 1.45;
           background: #f7f7f9; border: 1px solid #e2e2e8; border-radius: 8px;
           padding: 14px 16px; overflow-x: auto; }
  .agrid .row { white-space: nowrap; height: 1.45em; }
  .agrid .c, .agrid .c2 { display: inline-block; overflow: hidden; vertical-align: top; height: 1.45em; }
  .agrid .c { width: 1ch; }
  .agrid .c2 { width: 2ch; }
  .mermaid { background: #f7f7f9; border: 1px solid #e2e2e8; border-radius: 8px;
             padding: 20px; text-align: center; overflow: auto; max-height: 82vh; }
  .mermaid svg g.node { cursor: pointer; }
  .chart-tools { margin: 0 0 8px; font-size: 13px; color: #888; }
  .chart-tools button { border: 1px solid #d0d0d8; background: #fff; border-radius: 6px;
                        padding: 2px 10px; cursor: pointer; font-size: 13px; margin-right: 6px; }
  .chart-tools button:hover { background: #f0f0f4; }
  .chart-tools .hint { margin-left: 8px; font-size: 12px; }
  /* 阶段标题加底色盖住穿过的连线，避免文字压线 */
  .mermaid .cluster-label span { background: #f8fafc; padding: 0 6px; border-radius: 3px; }
  details { margin: 8px 0 16px; font-size: 13px; color: #666; }
  details pre { font-family: Menlo, monospace; font-size: 12px; background: #fafafa;
                border: 1px solid #eee; border-radius: 6px; padding: 12px; overflow-x: auto; }
  /* 节点详情弹窗 */
  .nm-overlay { position: fixed; inset: 0; background: rgba(15,23,42,.4);
                display: flex; align-items: center; justify-content: center; z-index: 999; }
  .nm-card { background: #fff; border-radius: 12px; width: min(560px, 92vw); max-height: 82vh;
             display: flex; flex-direction: column; box-shadow: 0 12px 40px rgba(0,0,0,.25);
             text-align: left; }
  .nm-head { display: flex; justify-content: space-between; align-items: center;
             padding: 14px 18px 10px; font-size: 16px; border-bottom: 1px solid #eee; }
  .nm-head button { border: none; background: none; font-size: 22px; cursor: pointer;
                    color: #888; line-height: 1; }
  .nm-head button:hover { color: #333; }
  .nm-body { padding: 12px 18px; overflow-y: auto; font-size: 14px; }
  .nm-row { display: flex; margin: 6px 0; }
  .nm-k { flex: 0 0 64px; color: #888; }
  .nm-v { flex: 1; word-break: break-word; }
  .nm-v code { font-family: Menlo, monospace; font-size: 12px; background: #f0f0f4;
               padding: 1px 4px; border-radius: 3px; }
  .nm-foot { padding: 10px 18px 14px; border-top: 1px solid #eee;
             display: flex; align-items: center; gap: 10px; }
  .nm-foot button { border: 1px solid #d0d0d8; background: #fff; border-radius: 6px;
                    padding: 5px 14px; cursor: pointer; font-size: 13px; }
  .nm-foot button:hover { background: #f0f0f4; }
  .nm-foot .ok { color: #1a7f1a; font-size: 13px; }
</style>
</head>
<body>
<h1>__PROJECT__ · 方案报告</h1>
<p class="meta">生成时间：__TIME__ ｜ 由 gen_report.py 自动生成 ｜ 单文件离线可用 ｜ 复写只留最新</p>

<h2>1. 整体目标</h2>
<div class="goal"><strong>一句话目标</strong>：__ONE_LINER__</div>
<table>
  <tr><th>指标</th><th>目标值</th><th>说明</th></tr>
__METRIC_ROWS__
</table>

<h2>2. 工程流程图</h2>
<p class="legend">节点颜色即复杂度：
  <span class="badge low">🟢 低</span>
  <span class="badge mid">🟡 中</span>
  <span class="badge high">🔴 高</span><br>
  形状即类型：矩形=处理 ｜ 菱形=判断 ｜ 虚线粗框=循环/回流 ｜ 圆头=开始/结束
  ｜ 平行四边形=输入/输出 ｜ 双边框=子流程 ｜ 圆柱=数据存储 ｜ 分组框=阶段</p>
<div class="chart-tools">
  <button data-z="out">− 缩小</button>
  <button data-z="in">＋ 放大</button>
  <button data-z="fit">适应宽度</button>
  <button data-z="reset">100%</button>
  <span class="zoom-level">100%</span>
  <span class="hint">点击节点看详情（可复制）｜ 双指滑动/拖拽平移 ｜ 双指捏合缩放</span>
</div>
<div class="mermaid">
__MERMAID_CODE__
</div>
<div id="node-modal" class="nm-overlay" style="display:none">
  <div class="nm-card">
    <div class="nm-head"><span id="nm-title"></span><button id="nm-close" title="关闭">×</button></div>
    <div class="nm-body" id="nm-body"></div>
    <div class="nm-foot">
      <button id="nm-copy">📋 复制节点信息</button>
      <span id="nm-copied" class="ok"></span>
    </div>
  </div>
</div>
<details class="fold">
  <summary>📑 索引表（点击展开）</summary>
  <table>
    <tr><th>ID</th><th>节点名称</th><th>功能介绍</th><th>相关代码</th><th>复杂度</th><th>风险</th></tr>
__NODE_ROWS__
  </table>
</details>

<h2>3. 当前状态</h2>
__STATUS_HTML__

<h2>4. 当前TODO</h2>
<table class="todo-table">
  <colgroup>
    <col class="c-id"><col class="c-prio"><col class="c-text"><col class="c-text"><col class="c-text"><col class="c-cmplx"><col class="c-narrow"><col class="c-narrow">
  </colgroup>
  <tr><th>编号</th><th>优先级</th><th>做什么</th><th>为什么做这件事</th><th>验证方法</th><th>复杂度</th><th>风险</th><th>依赖</th></tr>
__TODO_ROWS__
</table>

<h2>5. 经验沉淀</h2>
__EXP_HTML__

<h2>6. 当前仓库结构</h2>
__REPO_HTML__

<script>__MERMAID_JS_INLINE__</script>
<script>
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'loose',
    flowchart: { htmlLabels: true, curve: 'basis', useMaxWidth: false }
  });
  var NODE_DATA = __NODE_DATA__;
  mermaid.run({ querySelector: '.mermaid' }).then(function () {
    var box = document.querySelector('.mermaid');
    var svg = box.querySelector('svg');
    if (!svg) return;
    var vb = svg.viewBox && svg.viewBox.baseVal;
    var natW = (vb && vb.width) ? vb.width : svg.getBoundingClientRect().width;
    var zoom = 1;
    var label = document.querySelector('.zoom-level');
    function apply() {
      svg.style.width = (natW * zoom) + 'px';
      svg.style.height = 'auto';
      svg.style.maxWidth = 'none';
      label.textContent = Math.round(zoom * 100) + '%';
    }
    // 以某个屏幕点为中心缩放（捏合/按钮都走这里）
    function zoomAt(factor, cx, cy) {
      var r = box.getBoundingClientRect();
      var px = cx - r.left + box.scrollLeft;
      var py = cy - r.top + box.scrollTop;
      var nz = Math.min(Math.max(zoom * factor, 0.15), 4);
      var k = nz / zoom;
      zoom = nz;
      apply();
      box.scrollLeft = px * k - (cx - r.left);
      box.scrollTop = py * k - (cy - r.top);
    }
    function zoomCenter(factor) {
      var r = box.getBoundingClientRect();
      zoomAt(factor, r.left + r.width / 2, r.top + r.height / 2);
    }
    apply();
    document.querySelector('.chart-tools').addEventListener('click', function (e) {
      var z = e.target.getAttribute('data-z');
      if (!z) return;
      if (z === 'in') zoomCenter(1.25);
      else if (z === 'out') zoomCenter(1 / 1.25);
      else if (z === 'reset') { zoom = 1; apply(); }
      else if (z === 'fit') {
        zoom = Math.max((box.clientWidth - 44) / natW, 0.15);
        apply();
        box.scrollLeft = 0; box.scrollTop = 0;
      }
    });
    // 触控板：双指滑动 = 平移；双指捏合（浏览器报为 ctrl+wheel）= 缩放
    box.addEventListener('wheel', function (e) {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
      } else {
        box.scrollLeft += e.deltaX;
        box.scrollTop += e.deltaY;
      }
    }, { passive: false });
    // 鼠标按住拖拽平移（位移超 4px 才算拖拽，否则留给点击节点）
    var down = false, moved = false, sx = 0, sy = 0, sl = 0, st = 0;
    box.addEventListener('mousedown', function (e) {
      down = true; moved = false;
      sx = e.clientX; sy = e.clientY; sl = box.scrollLeft; st = box.scrollTop;
    });
    window.addEventListener('mousemove', function (e) {
      if (!down) return;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) + Math.abs(dy) > 4) { moved = true; box.style.cursor = 'grabbing'; }
      if (moved) { box.scrollLeft = sl - dx; box.scrollTop = st - dy; }
    });
    window.addEventListener('mouseup', function () {
      down = false; box.style.cursor = '';
      setTimeout(function () { moved = false; }, 0);
    });
    // 点击节点 → 详情弹窗（内容可整段复制给 agent）
    var overlay = document.getElementById('node-modal');
    function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
    function nodeText(id, n) {
      var lines = ['【' + id + '】' + n.name,
                   '阶段：' + n.stage + ' ｜ 复杂度：' + n.c_label,
                   '功能：' + n.func];
      if (n.code && n.code.length) lines.push('相关代码：' + n.code.join('、'));
      lines.push('风险：' + n.risk);
      if (n.note && n.note.length) {
        lines.push('备注：');
        n.note.forEach(function (x, i) { lines.push('  ' + (i + 1) + '. ' + x); });
      }
      return lines.join(String.fromCharCode(10));
    }
    var curText = '';
    function showModal(title, bodyHTML, copyText, copyLabel) {
      document.getElementById('nm-title').innerHTML = title;
      document.getElementById('nm-body').innerHTML = bodyHTML;
      curText = copyText || '';
      var copyBtn = document.getElementById('nm-copy');
      copyBtn.style.display = copyText ? '' : 'none';
      copyBtn.textContent = copyLabel || '📋 复制节点信息';
      document.getElementById('nm-copied').textContent = '';
      overlay.style.display = 'flex';
    }
    function openNode(id) {
      var n = NODE_DATA[id];
      if (!n) return;
      var rows = [
        ['阶段', esc(n.stage)],
        ['功能', esc(n.func)],
        ['相关代码', n.code && n.code.length
          ? n.code.map(function (c) { return '<code>' + esc(c) + '</code>'; }).join(' ')
          : '—'],
        ['复杂度', n.c_label],
        ['风险', esc(n.risk)]
      ];
      if (n.note && n.note.length) {
        rows.push(['备注', '<ul style="margin:0;padding-left:18px">' +
          n.note.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>']);
      }
      var body = rows.map(function (r) {
        return '<div class="nm-row"><span class="nm-k">' + r[0] + '</span>' +
               '<span class="nm-v">' + r[1] + '</span></div>';
      }).join('');
      showModal(n.c_emoji + ' <b>' + esc(id) + '</b> · ' + esc(n.name), body, nodeText(id, n));
    }
    // 状态「查看全部」：弹浮窗看完整历史（已完成/已中止）
    Array.prototype.forEach.call(document.querySelectorAll('.hist-btn'), function (btn) {
      btn.addEventListener('click', function () {
        var store = document.getElementById(btn.getAttribute('data-hist'));
        if (!store) return;
        var NL = String.fromCharCode(10);
        var lis = store.querySelectorAll('li');
        var txt = (store.getAttribute('data-title') || '') + NL +
          Array.prototype.map.call(lis, function (li, i) {
            return (i + 1) + '. ' + li.textContent;
          }).join(NL);
        showModal(store.getAttribute('data-title') || '历史记录', store.innerHTML, txt, '📋 复制全部');
      });
    });
    svg.addEventListener('click', function (e) {
      if (moved) return;
      var g = e.target.closest ? e.target.closest('g.node') : null;
      if (!g) return;
      var m = /^flowchart-([A-Za-z][A-Za-z0-9_]*)-[0-9]+$/.exec(g.id || '');
      if (m) openNode(m[1]);
    });
    function closeModal() { overlay.style.display = 'none'; }
    document.getElementById('nm-close').addEventListener('click', closeModal);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeModal(); });
    window.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });
    document.getElementById('nm-copy').addEventListener('click', function () {
      function done() { document.getElementById('nm-copied').textContent = '已复制 ✓'; }
      function legacy() {
        var ta = document.createElement('textarea');
        ta.value = curText;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch (err) {}
        document.body.removeChild(ta);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(curText).then(done, function () { legacy(); done(); });
      } else { legacy(); done(); }
    });
  }).catch(function (e) {
    document.querySelector('.mermaid').innerHTML =
      '<p style="color:#c0392b">流程图渲染失败：' + e.message + '</p>';
  });
</script>
</body>
</html>
"""


def badge(level: str) -> str:
    return f'<span class="badge {level}">{EMOJI[level]} {LABEL[level]}</span>'


def esc(s) -> str:
    return html_mod.escape(str(s))


def render_html(d: dict, mermaid_code: str, ts: datetime) -> str:
    if not MERMAID_JS.exists():
        print(f"❌ 缺少 mermaid 渲染引擎：{MERMAID_JS}", file=sys.stderr)
        print("  它约 3.2MB，是生成「单文件离线报告」用的。二选一：", file=sys.stderr)
        print(f"  a) 下载到脚本同目录：sh '{SCRIPT_DIR}/get_mermaid.sh'", file=sys.stderr)
        print("  b) 用已有副本：export HANDOFF_MERMAID=/path/to/mermaid.min.js", file=sys.stderr)
        sys.exit(1)
    mermaid_js = MERMAID_JS.read_text(encoding="utf-8")
    if "</script" in mermaid_js:
        mermaid_js = mermaid_js.replace("</script", "<\\/script")

    g = d["goal"]
    metric_rows = "\n".join(
        f"  <tr><td>{esc(m['name'])}</td><td>{esc(m['target'])}</td><td>{esc(m['how'])}</td></tr>"
        for m in g.get("metrics", [])
    )
    def code_cell_html(n):
        items = node_code(n)
        return "<br>".join(f"<code>{esc(x)}</code>" for x in items) or "—"
    # 节点详情数据：点击图上节点时弹窗展示（图上只放短名称，备注全部在这里）
    node_data = {}
    for n in d["nodes"]:
        note = n.get("note", [])
        if isinstance(note, str):
            note = [note]
        cx = n["complexity"]
        node_data[n["id"]] = {
            "name": n["name"], "stage": n["stage"], "func": n["func"],
            "risk": n["risk"], "note": note, "code": node_code(n),
            "c_emoji": EMOJI[cx], "c_label": f"{EMOJI[cx]} {LABEL[cx]}",
        }
    node_data_js = json.dumps(node_data, ensure_ascii=False).replace("</", "<\\/")
    node_rows = "\n".join(
        f"  <tr><td>{esc(n['id'])}</td><td>{esc(n['name'])}</td><td>{esc(n['func'])}</td>"
        f"<td>{code_cell_html(n)}</td><td>{badge(n['complexity'])}</td><td>{esc(n['risk'])}</td></tr>"
        for n in d["nodes"]
    )
    # TODO 表默认按优先级从高到低（P0→P1→P2）展示；同优先级保持 JSON 中的先后顺序
    prio_rank = {p: i for i, p in enumerate(PRIO)}
    todos_sorted = sorted(d["todos"], key=lambda t: prio_rank.get(t["priority"], 9))
    todo_rows = "\n".join(
        f"  <tr><td>{esc(t['id'])}</td><td><span class=\"badge {t['priority'].lower()}\">{t['priority']}</span></td>"
        f"<td>{esc(t['what'])}</td><td>{esc(t['why'])}</td>"
        f"<td>{esc(t['verify'])}</td><td>{badge(t['complexity'])}</td>"
        f"<td>{esc(t['risk'])}</td><td>{esc(t.get('deps') or '无')}</td></tr>"
        for t in todos_sorted
    ) or '  <tr><td colspan="8" class="muted">（无待办：当前所有 TODO 均已销账）</td></tr>'
    return (HTML_TEMPLATE
            .replace("__PROJECT__", esc(d["project"]))
            .replace("__TIME__", ts.strftime("%Y-%m-%d %H:%M"))
            .replace("__ONE_LINER__", esc(g["one_liner"]))
            .replace("__METRIC_ROWS__", metric_rows)
            .replace("__MERMAID_CODE__", mermaid_code)
            .replace("__NODE_ROWS__", node_rows)
            .replace("__TODO_ROWS__", todo_rows)
            .replace("__STATUS_HTML__", status_html(d.get("status")))
            .replace("__EXP_HTML__", exp_html(d.get("experience")))
            .replace("__REPO_HTML__", repo_html(d.get("repo_tree")))
            .replace("__NODE_DATA__", node_data_js)
            .replace("__MERMAID_JS_INLINE__", mermaid_js))


def status_html(st) -> str:
    """4 列 2 行：进行中/阻塞全量；已完成/已中止最新 3 条 + 「查看全部」弹浮窗"""
    if not st:
        return '<p class="muted">尚未开始执行，本节随执行持续更新。</p>'
    groups = [
        ("doing", "🔄 进行中", True),
        ("blocked", "⛔ 阻塞", True),
        ("done", "✅ 已完成", False),
        ("aborted", "🛑 已中止", False),
    ]
    heads, cells, stores = [], [], []
    for key, title, show_all in groups:
        items = st.get(key) or []
        heads.append(f"<th>{title}（{len(items)}）</th>")
        if not items:
            cells.append('<td><ul><li class="muted">（无）</li></ul></td>')
            continue
        if show_all:
            body = "".join(f"<li>{esc(x)}</li>" for x in items)
            cells.append(f"<td><ul>{body}</ul></td>")
        else:
            head = "".join(f"<li>{esc(x)}</li>" for x in items[:3])
            more = (f'<br><button class="hist-btn" data-hist="hist-{key}">查看全部 {len(items)} 条…</button>'
                    if len(items) > 3 else "")
            cells.append(f"<td><ul>{head}</ul>{more}</td>")
            full = "".join(f"<li>{esc(x)}</li>" for x in items)
            stores.append(
                f'<div id="hist-{key}" class="hist-store" data-title="{title}（全部 {len(items)} 条）">'
                f"<ul>{full}</ul></div>")
    return ('<table class="status-table"><tr>' + "".join(heads) + "</tr><tr>"
            + "".join(cells) + "</tr></table>" + "".join(stores))


def exp_html(exp) -> str:
    if not exp:
        return '<p class="muted">执行过程中持续补充：踩过的坑、有效的做法、关键参数阈值。</p>'
    lis = "".join(f"<li>{esc(x)}</li>" for x in exp)
    return f'<div class="exp"><ul>{lis}</ul></div>'


def repo_html(tree) -> str:
    if not tree:
        return '<p class="muted">未提供：请在 JSON 的 repo_tree 填入 ASCII 树形结构（如 tree -L 2 输出）。</p>'
    return pre_grid_html(tree)


def pre_grid_html(text: str) -> str:
    """把 ASCII 文本渲染成固定宽度格子：每个字符进独立 1ch/2ch 格，任何字体下对齐都不漂"""
    rows = []
    for line in text.rstrip("\n").split("\n"):
        items = []
        for c in line:
            w = dw(c)
            if w == 0 and items:          # 组合符并入前一格
                pc, pw = items[-1]
                items[-1] = (pc + c, pw)
            else:
                items.append((c, 2 if w >= 2 else 1))
        cells = []
        for c, w in items:
            cls = "c2" if w == 2 else "c"
            cells.append('<span class="%s">%s</span>' % (cls, esc(c)))
        rows.append('<div class="row">%s</div>' % ("".join(cells) or '<span class="c"> </span>'))
    return '<div class="agrid">\n' + "\n".join(rows) + "\n</div>"


# ---------- 主流程 ----------

def unique_path(p: Path) -> Path:
    if not p.exists():
        return p
    i = 2
    while True:
        q = p.with_name(f"{p.stem}_v{i}{p.suffix}")
        if not q.exists():
            return q
        i += 1


def main():
    keep = "--keep" in sys.argv
    args = [a for a in sys.argv[1:] if a != "--keep"]
    if len(args) != 1:
        print("用法：python3 gen_report.py 输入.json [--keep]")
        sys.exit(1)
    src = Path(args[0])
    if not src.exists():
        print(f"❌ 找不到文件：{src}", file=sys.stderr)
        sys.exit(1)
    d = json.loads(src.read_text(encoding="utf-8"))
    validate(d)

    ts = datetime.now()
    mermaid_code = gen_mermaid(d)
    html = render_html(d, mermaid_code, ts)
    html_path = src.parent / f"{d['project']}_方案报告.html"
    html_path.write_text(html, encoding="utf-8")
    print(f"✅ 校验通过，已生成（复写）：{html_path}")
    if keep:
        snap = unique_path(src.parent / f"{d['project']}_方案报告_{ts.strftime('%Y%m%d_%H%M%S')}.html")
        snap.write_text(html, encoding="utf-8")
        print(f"📌 已留时间戳快照：{snap}")


if __name__ == "__main__":
    main()
