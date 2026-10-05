# plan-handoff

把项目方案写在一份 JSON 里，一条命令生成**单文件离线 HTML 报告**：整体目标（含衡量指标）、工程流程图、当前 TODO、当前状态、经验沉淀、当前仓库结构，六个板块一次看全。

适合两类场景：给一个项目做开工方案，以及执行过程中持续记录「现在卡在哪、TODO 到哪了」——JSON 是唯一源文件，报告随时可重新生成，HTML 可以直接转发给别人看（不依赖网络、不依赖任何服务）。

- 只用 Python 标准库，**不需要 pip 装任何东西**（`python3` 版本 3.6+ 即可）
- 报告内嵌 mermaid 渲染引擎，**打开即看图**，离线可用、单文件可转发
- 有校验：字段缺、节点 id 重复、连线指向不存在的节点、判断节点漏标分支，都会明确报错并拒绝写盘

## 3 分钟上手

想先看产物长什么样，直接双击打开 `examples/` 里那份生成好的 HTML。

第一步，准备渲染引擎（约 3.2MB，只要执行一次；如果 `ls mermaid.min.js` 已经有就跳过）：

```bash
cd plan-handoff
sh get_mermaid.sh          # 固定拉 v10.9.8，与仓库自带副本一致
```

第二步，写一份最小方案 JSON（存成 `min.json`；字段含义见 [`skill.md`](skill.md) 的「字段规范」）：

```json
{
  "project": "日报自动汇总",
  "goal": {
    "one_liner": "把 5 个群的日报自动汇总成一张表，替代人工复制粘贴",
    "metrics": [
      { "name": "人工耗时", "target": "从 30 分钟降到 0", "how": "次日 9 点自动出表" }
    ]
  },
  "nodes": [
    { "id": "N1", "name": "拉取日报", "stage": "采集", "complexity": "low", "type": "io",
      "func": "读 5 个群的导出文件 → 解析 → 得到结构化条目", "risk": "无" },
    { "id": "N2", "name": "去重汇总", "stage": "处理", "complexity": "mid",
      "func": "按人+日期去重 → 汇总 → 生成总表", "risk": "同名同姓会串，用花名兜底" }
  ],
  "todos": [
    { "id": "T1", "priority": "P0", "what": "写解析脚本", "why": "不解析拿不到数据",
      "verify": "跑一遍输出条目数对得上", "complexity": "mid", "risk": "格式不统一要返工", "deps": "无" }
  ]
}
```

第三步，生成报告：

```bash
python3 gen_report.py min.json
```

产物就一个文件：`min.json` 同目录下的 `日报自动汇总_方案报告.html`，双击用浏览器打开即可。

## 产物在哪、怎么覆盖

- 输出文件名固定为 `{project}_方案报告.html`，写在**输入 JSON 的同目录**。
- HTML 是**视图**，永远可以重新生成，所以每次直接**复写同名文件、只留最新**，不堆时间戳。
- 大改版前想留底，用快照模式额外存一份带时间戳的：

```bash
python3 gen_report.py min.json --keep
```

## 日常维护：别手改 JSON，用 hdo

初版骨架手写；之后 TODO、当前状态、经验沉淀、仓库结构一律用 `hdo.py` 改，它改完自动校验、自动重新生成 HTML，校验不过文件不动：

```bash
python3 hdo.py <方案.json> show                    # 概览：节点/边/TODO 数、P0 数量、阻塞与进行中
python3 hdo.py <方案.json> show todo               # 只看某一板块：goal|todo|status|exp|tree|nodes
python3 hdo.py <方案.json> todo add --priority P0 --what ".." --why ".." --verify ".." --complexity mid --risk ".."
python3 hdo.py <方案.json> todo done T3 已完成说明   # 完成后从 TODO 移除，记入「已完成」
python3 hdo.py <方案.json> status doing "T3 写解析脚本（60%）"
python3 hdo.py <方案.json> status block "等上游给样例文件"
python3 hdo.py <方案.json> exp add "导出文件有 BOM，读的时候要 utf-8-sig"
python3 hdo.py <方案.json> tree set < 树.txt        # 刷新仓库结构，可 tree -L 2 > 树.txt
python3 hdo.py <方案.json> gen                     # 手改过 JSON 后重新生成
```

在目标仓库里一次建好目录和骨架：

```bash
python3 hdo.py init <仓库目录> <项目名>            # 生成 <仓库目录>/handoff/YYMMDD_项目名_方案.json
```

完整命令表和每个字段的含义见 [`skill.md`](skill.md)。

## 文件说明

- [`skill.md`](skill.md) —— **给 agent 读的说明书**：字段规范、校验规则、命名约定、`/handoff` 读流程与浮窗交互。让 AI 干活前先把这份读全。
- [`hdo.py`](hdo.py) —— 维护 CLI，零依赖。
- [`gen_report.py`](gen_report.py) —— 报告生成器，零三方库。
- [`模板.json`](模板.json) —— 八键空白骨架（`hdo init` 照它生成新方案）。
- [`get_mermaid.sh`](get_mermaid.sh) —— 下载 mermaid 渲染引擎到本目录。
- [`examples/`](examples/) —— 三个可直接跑的示例 JSON：单链版、DAG 版（带节点类型）、多节点压测版。
- [`extensions/handoff.ts`](extensions/handoff.ts) —— 可选的 pi 扩展本体，提供 `/handoff` 浮窗入口。
- [`index.ts`](index.ts) —— 扩展入口转接：让整个文件夹能被 pi 直接加载（pi 只认目录下的 `index.ts`）。

## 可选：装成 /handoff 浮窗入口

只用命令行的话这步可以跳过。装了之后在任意项目里敲 `/handoff` 会弹浮窗：先选「读」还是「写」，再自动列出当前仓库 `handoff/` 下的方案 JSON 让你确认，最后把一条指令发给 agent——写模式去更新方案，读模式要求 agent 调查仓库后汇报「项目背景 / 项目目标 / 当前 TODO」。

安装方式看你想怎么放（pi 扫描扩展目录时只认两种情况：目录下的 `*.ts` 文件，或者子目录里的 `index.ts`）：

```bash
# 方式一（推荐，零配置）：整包放进去，扩展会自己找到同级的 hdo.py 和 skill.md
cp -r plan-handoff ~/.pi/agent/extensions/plan-handoff

# 方式二：只放单文件，工具目录留在别处（首次运行会问你要路径）
cp plan-handoff/extensions/handoff.ts ~/.pi/agent/extensions/handoff.ts

# 方式三：不安装，临时加载（开发调试用）
pi --extension /path/to/plan-handoff/index.ts
```

工具目录不想被自动发现时，也可以直接指定：

```bash
export HANDOFF_TOOL_DIR=/path/to/plan-handoff     # 含 hdo.py 与 skill.md 的目录
export HANDOFF_MERMAID=/path/to/mermaid.min.js    # 可选：多个项目共用一份渲染引擎
export HANDOFF_PYTHON=python                      # 可选：默认 python3
```

都没有的话，第一次执行 `/handoff` 会问你要工具目录，验证通过后写进 `~/.pi/agent/handoff-tool.json`，之后不再问。

## 常见问题

- **报错「缺少 mermaid 渲染引擎」**：跑 `sh get_mermaid.sh`，或者用 `export HANDOFF_MERMAID=/path/to/mermaid.min.js` 指向已有副本。
- **生成的报告打开是空白 / 一直转圈**：确认 `mermaid.min.js` 是同目录下真实存在的完整文件（3.2MB 左右），下载中断的残缺文件会导致渲染失败。
- **想让流程从「单链」变成「分支/并行/回流」**：在 JSON 里加 `edges` 数组即可（不加就是按节点顺序连的单链）；判断分支用 `"type": "decision"`，要求至少两条出边且每条都写 `label`。
- **节点名太长图上挤**：建议节点 `name` ≤10 字，细节放 `func` 或 `note`（`note` 不显示在图上，点节点弹窗里看）。
- **中文文件名行不行**：行，输出文件名直接取 `project` 字段。

## 依赖

- Python 3.6+（只用标准库：`json` / `re` / `sys` / `os` / `unicodedata` / `datetime` / `pathlib` / `subprocess`）
- `mermaid.min.js`（10.9.8，约 3.2MB，可下载或共用）
