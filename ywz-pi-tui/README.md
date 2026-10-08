# ywz-pi-tui —— pi 状态栏升级 + 对话美化方案

pi coding agent 的整套 TUI 显示方案：**pi-pretty-tui**（对话区美化，第三方包）+ **pretty-footer**（状态栏升级，自研扩展）。

两者互不干扰：pretty-tui 负责活动时间线、聊天气泡、代码块折叠；pretty-footer 只替换底部状态栏，均使用 pi 公开扩展 API，可随时卸载恢复原生。

```
⌂ ~/Desktop/111Workspace  ⎇ main  · 会话名
↑24k ↓6.9k │ R182k W4.1k │ 命中 86% │ 本轮 $0.0370 · 累计 $0.225 │ ▰▰▱▱▱▱▱▱ 23.4%   mimo-v2.6-pro · high
💬 BRIEF
```

## 目录结构

```
ywz-pi-tui/
├── pi-pretty-tui/          # 对话区美化包（MIT，作者 Kainan Yang，本地安装快照 v0.2.6）
│   ├── extensions/         # 扩展源码（index / activity-timeline / nested-tools）
│   ├── assets/             # 效果截图
│   └── README.zh-CN.md     # 完整功能说明
├── pretty-footer/          # 自研状态栏扩展
│   ├── pretty-footer.ts    # 扩展本体（放 ~/.pi/agent/extensions/）
│   └── tests/              # 渲染快照测试（mock API，不启动 pi）
└── config/                 # 配置文件示例
    ├── settings-snippet.json   # settings.json 中 TUI 相关片段
    └── pretty-footer.json      # pretty-footer 开关配置
```

## 安装

### 1. pi-pretty-tui（对话区美化）

```sh
pi install npm:pi-pretty-tui
```

重启 pi 或 `/reload` 生效。安装时如提示「内置工具被覆盖」属正常现象（它重注册内置工具只改渲染，执行委托原实现）。

运行 `/pretty-tui` 打开设置，三种渲染模式：`clean`（默认，折叠活动时间线）/ `compact` / `full`。

### 2. pretty-footer（状态栏升级）

把 `pretty-footer/pretty-footer.ts` 复制到 `~/.pi/agent/extensions/`：

```sh
cp pretty-footer/pretty-footer.ts ~/.pi/agent/extensions/
```

pi 启动时自动加载（与 `brief-mode.ts` 等扩展同一机制）。`/reload` 生效。

### 3. 配置

- `config/settings-snippet.json` → 合并进 `~/.pi/agent/settings.json`（`packages` 里加 `"npm:pi-pretty-tui"`）
- `config/pretty-footer.json` → 放 `~/.pi/agent/pretty-footer.json`（不创建则默认启用）

## pretty-footer 功能

- **两行布局**：上行位置信息（cwd / git 分支 / 会话名），下行指标分组（流量 / 缓存 / 命中率 / 花费 / 上下文占用）
- **本轮花费**：每条新用户消息起，整轮工具循环所有模型调用的实际花费总和；同时显示会话累计花费
- **上下文进度条**：`▰▰▱▱▱▱▱▱ 23.4%`，超过 70% / 90% 变黄 / 变红
- **窄终端降级**：60 列以下先砍缓存组、命中率，再简化花费，最后截断，不破版
- **点击交互**（fullscreen 模式）：点路径复制 cwd、点分支复制分支名、点右侧模型区切换 thinking level
- **扩展状态行**：其他扩展 `ctx.ui.setStatus()` 的状态（如 brief-mode 的 `💬 BRIEF`）原样保留在第三行
- **零侵入**：只用 `ctx.ui.setFooter()` 公开 API，不碰 pi 渲染补丁，与 pi-pretty-tui 无冲突面

### 命令

```
/pretty-footer [enable|disable|status]
```

### 测试

```sh
cd ~/.pi/agent/extensions/tests && node pretty-footer.test.mjs
```

覆盖：多宽度渲染快照（120/80/60/40/24 列）、本轮/累计花费计算与轮次重置、鼠标命中区域、上下文占用变色。

## 兼容性与注意

- 基线：pi 1.0.1（pretty-tui 官方适配版本）；嵌套工具需 pi 0.99.0+
- pi 只支持一个自定义 footer：若将来装其他也调 `setFooter` 的扩展，后装的会覆盖本扩展
- pretty-footer 的 `turnCost` 轮次边界只认 user 消息，steer 中途插话算进上一轮
- 卸载：删 `~/.pi/agent/extensions/pretty-footer.ts` + `pi remove npm:pi-pretty-tui`，即恢复 pi 原生显示

## License

- pi-pretty-tui：MIT（归原作者 Kainan Yang，仓库 https://github.com/ykn0309/pi-pretty-tui）
- pretty-footer：自研，随本仓库使用
