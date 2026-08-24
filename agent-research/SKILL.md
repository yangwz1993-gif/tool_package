---
name: agent-research
description: 多 agent 并行调研 + 出题编排器。用户给调研目标（如"找出N条agent/vibecoding测试题"），自动切分子任务、并行子agent检索（微博/小红书/知乎/公众号）、每子agent多步ReAct检索并生成可执行测试题（含task/难度/验收标准）、汇总检查、不达标自动迭代新检索策略，最后输出汇总表格。适合任何"跨平台找内容并加工成结构化结果"的任务。
---

# Agent Research 多代理调研编排

## 用途

把「跨平台检索内容 + 加工成结构化结果」变成全自动流水线。典型场景：找 agent/vibecoding 测试题、竞品内容调研、热点追踪、素材收集。

## 架构

```
用户输入 ──► orchestrator.mjs（主 agent）
              │  ① 意图理解 & 切分子任务（按目标数量/平台分配）
              ▼
         ┌──── 并行子 agent ────┐
         │ 子agent1: 微博+出题   │
         │ 子agent2: 小红书+出题 │  ← 每个独立 pi session
         │ 子agent3: 知乎+出题   │    多步 ReAct 检索
         │ 子agent4: 公众号+出题 │    上下文临界自动 compact
         └────────┬─────────────┘
                  ▼
         main agent 汇总检查
              │  质量不达标 → 制定新检索策略 → 重新分配
              ▼
         达标 → 输出表格 (final.json / Excel)
```

## 快速开始

```bash
# 1. 安装依赖（首次）
cd agent-research-skill
npm install playwright
npx playwright install chromium

# 2. 准备 cookie（各平台登录态，否则该平台检索不可用）
node scripts/cookie_persist.mjs weibo.com weibo.cookie     # 微博
node scripts/cookie_persist.mjs zhihu.com zhihu.cookie     # 知乎
# 小红书: xhs.cookie（已有）

# 3. 运行编排器（带预算）
node orchestrator.mjs "找出10条agent/vibecoding build类测试题" --target 10 --budget 3
```

## 预算控制（重要）

- **模型**：文本用 `deepseek-v4-flash`，图片 OCR 用 `deepseek-v4-flash-vision-exp`（DS 官网文档确认，图片按尺寸计费，每张 ≤384 tokens）。
- **价格**（元/百万 tokens，官网 2026-08）：输入未命中 1.5、缓存命中 0.05、输出 4.5（空闲）；高峰（工作日 9-12/14-18 北京）翻倍。
- **预算参数**：`--budget <元>`。编排器启动时基于上次任务成本估算合理性（`results/cost_history.json`）。
- **90% 停止线**：子 agent 每步上报真实 token 用量（从 session usage 事件），预算使用到 90% 即停止启动新子 agent。
- **成本记录**：每次运行后写 `results/cost_history.json`，供下次预算估算。

## 子 agent 的检索工具（lib/）

| 工具 | 平台 | 需要 cookie | 输出 |
|------|------|------------|------|
| `lib/search_weibo.mjs "<关键词>"` | 微博 s.weibo.com | weibo.cookie | [{user,time,text,link}] |
| `lib/search_xhs.mjs "<关键词>"` | 小红书 | xhs.cookie | [{id,title,author,likes,url}] |
| `lib/search_zhihu.mjs "<关键词>"` | 知乎 | zhihu.cookie | [{title,href}] |
| `lib/search_wx.mjs "<关键词>"` | 公众号(搜狗) | 无 | [{title,ts,real_url,content}] |

## 自定义

- **换数据源**：在 `orchestrator.mjs` 的 `subTasks` 数组增删平台；每个子任务可指定不同的检索工具和出题数量。
- **换出题规则**：改 `SYSTEM_TEMPLATE` 里子 agent 的系统提示（如改 build 类定义、验收标准格式）。
- **压缩阈值**：`SettingsManager.inMemory({ compaction: { threshold: 80000 } })` 控制子 agent 上下文压缩时机。
- **主 agent 检查逻辑**：当前 `orchestrator.mjs` 尾部做去重+数量过滤；更严格的质量检查可让 pi 主 agent 读取 final.json 后复核，不合格则调用子任务重跑。

## 输出

- `results/final.json` — 结构化题目数组
- 转 Excel：`python3 make_excel.py results/final.json out.xlsx`

## 注意

- cookie 是敏感文件，勿提交 git（.gitignore 已排除）。
- 各平台有反爬，检索频率不宜过高；子 agent 应控制请求节奏（工具已内置 sleep）。
- 小红书/知乎/微博需有效登录 cookie，否则检索返回空。
