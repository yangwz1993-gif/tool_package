# plan-handoff · 使用说明（Agent 必读）

把一个项目的**整体目标 / 工程流程图 / 当前 TODO / 当前状态 / 经验沉淀 / 仓库结构**记在一份 JSON 里，一条命令生成**单文件离线 HTML 报告**。

Agent 做方案/决策流程时**只填 JSON，不画任何图**。六个板块全部由 `gen_report.py` 从 JSON 生成。报告是「活文档」：初版只有目标/流程/TODO，执行过程中持续更新 status / experience / repo_tree 后重新生成。

**分工**：初版创建直接编辑 JSON；后续维护（todos/status/experience/repo_tree 的增删改）一律用 `hdo.py` 命令，改完自动校验+自动重新生成，禁止再全量重写 JSON；流程图 nodes/edges、goal 等结构性低频改动可直接编辑 JSON，改完跑 `hdo gen`。

## 文件清单

| 文件 | 作用 |
|------|------|
| `gen_report.py` | 生成器（零三方库）：校验 JSON → HTML 报告（内嵌 mermaid，单文件离线可看） |
| `hdo.py` | 维护工具（零依赖）：todos/status/experience/repo_tree 增删改查 + 自动重新生成 |
| `mermaid.min.js` | 本地渲染引擎（约 3.2MB），内嵌进 HTML，单文件离线可看 |
| `get_mermaid.sh` | 没带 mermaid 时用它下载到本目录（也可以设 `HANDOFF_MERMAID` 指向已有副本） |
| `skill.md` | 本文件：Agent 干活前必读的约定与字段规范 |
| `模板.json` | 八键空白骨架，`hdo init` 就是照它生成新方案 |
| `extensions/handoff.ts` | 可选的 pi 扩展本体：提供 `/handoff` 浮窗入口（读/写两条路径） |
| `index.ts` | 扩展入口转接：让整个文件夹能被 pi 直接加载（pi 只认目录下的 `index.ts`） |
| `README.md` | 给人看的 3 分钟上手指南 |
| `examples/` | 三个可直接跑的示例输入：单链版 / DAG 版（带节点类型）/ 多节点压测版，另附一份生成好的 HTML 产物样例 |

## 这套工具装在哪（位置前提）

- 这个文件夹**可以放在任何位置**，脚本之间只用相对自身目录的路径互相找（`Path(__file__).resolve().parent`），内部没有写死任何人的绝对路径。
- `skill.md` **不是 pi 自动加载的 skill**（它没有 frontmatter、也不放在 pi 的 skills 目录）：它是给 agent 读的说明书，靠 `/handoff` 扩展或人工把路径告诉 agent。所以「装在哪」不影响可用性，只影响你怎么把路径告诉 agent。
- 想用 `/handoff` 浮窗的话有两种装法：整包拷进 `~/.pi/agent/extensions/plan-handoff/`（pi 加载其中的 `index.ts`，扩展自己找到同级的 hdo.py/skill.md，零配置）；或只拷 `extensions/handoff.ts` 到 `~/.pi/agent/extensions/handoff.ts`（首次运行会问你工具目录）。
- `/handoff` 扩展按这个顺序找工具目录：环境变量 `HANDOFF_TOOL_DIR` → 配置文件 `~/.pi/agent/handoff-tool.json` 的 `toolDir` → 扩展自己所在目录及其上一级 → 都没有就在浮窗里问你一次并把路径记进配置文件。
- 环境变量 `HANDOFF_MERMAID` 可指向别处的 `mermaid.min.js`（多项目共用一份，不必到处放 3.2MB）；`HANDOFF_PYTHON` 可指定 python 解释器（默认 `python3`，Windows 上常要改成 `python`）。

## 用法

```bash
# 前置：需要 python3（只用标准库，不需要 pip 装任何东西）
#       以及同目录的 mermaid.min.js —— 没有就跑：sh get_mermaid.sh

# 生成报告（产物只有 HTML）
python3 gen_report.py 输入.json
# 输出：{project}_方案报告.html（写在 JSON 同目录，固定名复写只留最新；--keep 可额外留时间戳快照）

# 建一个新方案（在目标仓库根目录生成 handoff/ 与 JSON 骨架）
python3 hdo.py init <仓库目录> <项目名>

# 日常维护用 hdo（改完自动重新生成，一行命令搞定）
python3 hdo.py handoff/方案.json todo done T3
```

校验失败会直接报错退出（缺字段 / 节点 id 重复 / 引用了不存在的节点 / complexity 非法 / 判断节点缺带 label 的出边等），改对再跑。

## handoff 目录约定（/handoff 命令触发时必须遵守）

1. 在**当前项目仓库根目录**下建 `handoff/` 文件夹（已存在则直接用；可用 `hdo init <仓库目录> <项目名>` 一步建好）
2. 方案 JSON 放在 handoff/ 下，命名：`YYMMDD_项目名_方案.json`
   - 已有同项目 JSON：**直接更新该 JSON**（JSON 是源文件，随执行持续改）
3. **维护一律走 hdo 命令**，改完自动重新生成 HTML；只有初版创建和流程图/目标等结构性改动才直接编辑 JSON（改完 `hdo <json> gen`）：

   ```bash
   HDO=<本工具所在目录>/hdo.py   # 例：HDO=~/.pi/agent/extensions/plan-handoff/hdo.py
   python3 $HDO handoff/YYMMDD_项目名_方案.json todo done T3
   ```

   输出的 HTML 自动写在 handoff/ 下，固定文件名 `{项目}_方案报告.html`，**每次复写只留最新**（HTML 是由 JSON 生成的视图，随时能重新生成，复写不会丢信息）；大改版前想留底：`python3 gen_report.py 输入.json --keep`。
4. 完成后向人汇报：JSON 路径 + 最新 HTML 路径。

## 读流程与浮窗交互（/handoff 命令）

`/handoff` 是 `extensions/handoff.ts` 提供的 pi 扩展入口（安装方式见 `README.md`）。全程浮窗交互，**交互过程不进上下文**，只有最后一条指令会作为用户消息发给 agent。

- 输入 `/handoff`（不带参数）：先选「读」还是「写」；Esc 随时取消。
- 输入 `/handoff <需求文字>`：跳过读/写选择，直接按写流程走，需求文字原样带进最终指令（兼容老用法）。
- 定位方案文件：扫当前仓库 `handoff/` 下所有 `*.json`，按修改时间倒序——
  - 只有一个：弹确认框，确认即用它，取消则手填路径；
  - 有多个：列表让你选（附修改时间），可选「自己填路径」；
  - 一个都没有 + 写模式：问是否在仓库根目录新建 `handoff/`，确认后填项目名，等价于跑一次 `hdo init <仓库目录> <项目名>`；
  - 一个都没有 + 读模式：直接让你粘贴 JSON 路径。
- 找不到工具目录（`hdo.py` 所在文件夹）时：浮窗问你一次路径，验证通过后写进 `~/.pi/agent/handoff-tool.json`，以后不再问。

**写模式发出的指令**：`根据 handoff 的要求更新 <JSON 路径>。本次需求：…` + 指向本文件「hdo.py 命令参考」「字段规范」「handoff 目录约定」三节，并要求先完整读 skill.md。

> 所以 agent 收到指令后第一件事是把 skill.md 读全，不要凭记忆或惯例开工；字段名、校验规则、命名约定全以本文件为准。

**读模式发出的指令**：`理解下 <JSON 路径>` + 说明这份 JSON 记什么 + 要求 agent **同时调查它所在的仓库**（README、目录结构、关键代码），最后简要汇报三件事：

- 项目背景（这个项目在干什么、给谁用）
- 项目目标（含衡量指标）
- 当前 TODO

读模式下 agent **不改任何文件**，只汇报。读流程的价值在于接手别人做过的项目：先读方案再动手；汇报时如果发现 JSON 与仓库实际状态对不上（TODO 已完成但没销账、文件已删但流程图里还画着、repo_tree 过期），要明确指出来，这是发现方案过期的主要手段。

## hdo.py 命令参考

| 命令 | 作用 |
|------|------|
| `hdo init <仓库目录> <项目名>` | 建 handoff/ + 从模板生成 JSON 骨架 |
| `hdo <json> show` | 概览：节点/边/TODO 数、P0 数量、阻塞与进行中清单 |
| `hdo <json> show goal\|todo\|status\|exp\|tree\|nodes` | 只看某一板块（纯文本输出，适合贴给 agent 讨论；todo 按优先级排序） |
| `hdo <json> gen` | 重新生成 HTML（手改 JSON 后用） |
| `hdo <json> todo add --priority P0\|P1\|P2 --what .. --why .. --verify .. --complexity low\|mid\|high --risk .. [--deps ..]` | 加 TODO，**全字段必填**，编号自动分配（T{max+1}） |
| `hdo <json> todo done <T编号> [备注]` | 完成：从 TODO 移除，记入「已完成」最前，并清掉同编号的进行中/阻塞 |
| `hdo <json> todo abort <T编号> [备注]` | 中止：从 TODO 移除，记入「已中止」最前（忽略/改方向也用它） |
| `hdo <json> todo edit <T编号> [--字段 值…]` | 改 TODO 任意字段 |
| `hdo <json> todo rm <T编号>` | 删 TODO（有 deps 引用时会警告） |
| `hdo <json> status doing <文本>` | 进行中置前；首词为 T编号 时替换同编号旧条目 |
| `hdo <json> status undoing <T编号>` | 移除进行中 |
| `hdo <json> status block <文本>` / `status unblock <T编号>` | 阻塞增/删（替换逻辑同 doing） |
| `hdo <json> status abort <文本>` / `status unabort <T编号>` | 已中止增/删（自由文本，替换逻辑同 doing） |
| `hdo <json> exp add <文本>` | 经验沉淀追加 |
| `hdo <json> tree set < 树.txt` | 刷新「当前仓库结构」（从标准输入读，支持 `tree -L 2 \| hdo … tree set`） |

全局选项 `--no-gen`：本次改完不重新生成 HTML。所有 mutating 命令先整体校验再写盘，**校验不过文件不动**。

## 字段规范

下面是**带注释的示意**（`//` 注释只为讲解，真 JSON 里不能写注释；实际起步直接复制 `模板.json` 改）。

```json
{
  "project": "项目名（说人话）",
  "goal": {
    "one_liner": "一句话目标：干什么、替代什么、什么时候交付",
    "metrics": [
      { "name": "指标名", "target": "目标值（能写数字就写数字）", "how": "怎么算达成" }
    ]
  },
  "nodes": [
    {
      "id": "N1",
      "name": "节点短名称（建议≤10字，超长生成时会警告；细节一律放 note/func）",
      "stage": "阶段名（相邻同 stage 的节点归为一个阶段，图里自动画分组框）",
      "complexity": "low | mid | high",
      "type": "可选，默认 process。节点类型见下表，形状表达类型、颜色仍由 complexity 决定",
      "func": "一句话：输入什么 → 干什么 → 输出什么",
      "risk": "会出什么事 + 怎么办；没有就写「无」",
      "code": "可选：相关代码，字符串或数组。写相对路径，可带函数名，如 scripts/fetch.py 或 judge/run.py::run_all()；没有就不填（表格里显示 —）",
      "note": ["可选：节点备注，每元素一条。图上不显示，点击节点弹窗里展示，可随节点信息一键复制"]
    }
  ],
  "edges": [
    ["N1", "N2a"],
    ["N2a", "N3"],
    { "from": "N6", "to": "N7", "label": "不合格" }
  ],
  "todos": [
    {
      "id": "T1",
      "priority": "P0 紧急先做 | P1 高 | P2 普通靠后（必填；判断标准=先做什么后做什么：不先做会挡住谁/会出什么事。TODO 表自动按 P0→P1→P2 排序展示）",
      "what": "做什么：当前待办的一件事（不与流程节点 1:1 绑定）",
      "why": "为什么做这件事：不做会怎样 / 支撑哪个指标",
      "verify": "验证方法：看哪条命令输出 / 哪个文件存在 / 哪个数字达标",
      "complexity": "low | mid | high",
      "risk": "出问题会怎样",
      "deps": "依赖：前置 todo id 或外部依赖；可并行要注明（如「T1（可与 T2b 并行）」）；没有写「无」"
    }
  ],
  "status": {
    "doing": ["可选：进行中事项 + 进度"],
    "blocked": ["可选：阻塞事项 + 卡在哪、在等谁"],
    "done": ["可选：已完成事项，最新完成的放数组最前"],
    "aborted": ["可选：已中止事项（被中止/忽略/改方向的 todo 或任务），最新的放最前"]
  },
  // 报告第 3 节「当前状态」固定 4 列：进行中 → 阻塞 → 已完成 → 已中止；
  // 进行中/阻塞全量展示，已完成/已中止只显示最新 3 条，更多点「查看全部」弹浮窗
  "experience": ["可选：经验沉淀，一条一行（踩过的坑 / 有效做法 / 关键参数阈值）"],
  "repo_tree": "可选：当前仓库结构 ASCII 树（如 tree -L 2 输出），多行用 \\n 连接"
}

// edges 可选：不写 = 顺序单链（N1→N2→…）；写了 = DAG 模式，连线完全按 edges 来
// 边支持两种写法：[from, to] 或 {"from","to","label":"可选文字"}（label 会标在连线上，如"合格/不合格"）
// DAG 模式下每个节点至少要连一条边，不允许自环和重复边（生成器硬校验）
```

## 节点类型（type 字段，可选）

| 值 | 形状 | 用途 | 约束 |
|----|------|------|------|
| `process` | 矩形（默认） | 普通处理 | — |
| `start` | 圆头 | 流程入口 | — |
| `end` | 圆头 | 结束/产出 | — |
| `decision` | 菱形 | 判断分支 | 只能用于 DAG 模式；≥2 条出边且每条必须写 label（如 合格/不合格），生成器硬校验 |
| `loop` | 虚线粗边框 | 循环/回流/重试体 | — |
| `io` | 平行四边形 | 数据读入/写出 | — |
| `data` | 圆柱体 | 中间结果/文件/DB | — |
| `subprocess` | 双边矩形 | 调子流程/并行 worker | — |

## 复杂度定义（标色全项目统一，不许凭感觉）

| 值 | 色标 | 含义 |
|----|------|------|
| `low` | 🟢 | 有现成工具/命令/脚本，一次跑通概率高，不用试错 |
| `mid` | 🟡 | 要写新代码或多步拼装，可能有坑，预留一次返工 |
| `high` | 🔴 | 核心难点或不确定项，大概率要试错，必须先小步验证再铺开 |

## 硬性规则

1. nodes 按执行顺序排列，编号 N1、N2…；todos 按优先级排列，编号 T1、T2…（可与节点编号无关），每条必须标 priority（P0/P1/P2）
2. 所有文字**说人话**：非技术人员能看懂；术语第一次出现要解释
3. risk 不许留空，没有风险写「无」；code 可以留空不填，但条目里不许有 | 和换行（会破坏表格）
4. 流程图方向固定为**从左到右**（阶段从左到右推进，阶段内节点竖排），支持两种模式：**顺序单链**（不写 edges，按 nodes 顺序连）和 **DAG**（写 edges，支持分支/并行/汇合/回流）；回流边用 label 注明含义（如"回流重判"）
5. 产物只有 HTML：单文件离线可看（内嵌 mermaid）。图的交互：点击节点弹详情弹窗（含备注和索引信息，可一键复制发给 agent）、双指捏合缩放、双指滑动或按住拖拽平移；流程走向固定为左上→右下。流程图 nodes/edges、goal 等结构性低频改动可直接编辑 JSON，改完跑 `hdo <json> gen` 重新生成
6. 节点 id 只能以字母开头、由字母数字下划线组成（N1/N2…即可）；name/stage/note 里不得出现半角 < > " \ ( ) / 字符（会破坏形状语法，请用全角或改写）
