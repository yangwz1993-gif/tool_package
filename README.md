这是一个管理我本地agent工具和技能包的仓库。

## 内容

- [`pi-discord-bridge/`](pi-discord-bridge/) —— pi × Discord 桥接：换台电脑怎么连、新建频道怎么把 pi 拉起来、房间与模型怎么管。含可复用的 pi 扩展、技能与脚本。
- [`pi-lark-bridge/`](pi-lark-bridge/) —— pi × 飞书桥接：飞书里私聊机器人或群里 @它，驱动本机 pi 干活。每个聊天独立会话与 herdr 分屏，一个聊天里还能开多个会话并行干活（`/new` · `/switch` · `/close`）。维护上游 pi-lark-bot 的改动（收到消息立刻贴 ✅ 的表情回应 + 多会话）、启动器、部署闸门（tsc + 测试）与踩坑记录。
- [`ywz-pi-tui/`](ywz-pi-tui/) —— pi 状态栏升级 + 对话美化方案：pi-pretty-tui（活动时间线/气泡/代码块折叠）+ 自研 pretty-footer 状态栏（本轮/累计花费、上下文进度条、点击复制/切换 thinking level），含源码、配置示例与测试。
- [`plan-handoff/`](plan-handoff/) —— 方案文档工具：项目目标/流程图/TODO/状态/经验/仓库结构写在一份 JSON 里，一条命令生成单文件离线 HTML 报告（内嵌 mermaid）。零依赖，纯 Python 标准库，附可选 `/handoff` 浮窗入口。
- [`kol-questions/`](kol-questions/) —— KOL 内容调研与测试题生成：多子 agent 并行检索微博/小红书/知乎/公众号，产出带 task/难度/验收标准的测试题与汇总 Excel。
- [`local-flowcharts/`](local-flowcharts/) —— 本地交互流程图：用自然语言生成/修改流程图与小型架构图，agent 维护 LikeC4 源码并交付单文件 HTML（可选 draw.io/SVG/PNG）。
