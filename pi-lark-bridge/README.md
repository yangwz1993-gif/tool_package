# pi-lark-bridge —— pi × 飞书桥接

在飞书里私聊机器人（或群里 @它），让它驱动本机的 pi 干活。每个私聊用户、每个群聊各自一个独立的 pi 会话和 herdr 分屏，历史与模型互不干扰；**一个聊天里还能同时开多个会话**（`/new`），互不干扰地并行干活。

这一套和仓库里的 [`pi-discord-bridge/`](../pi-discord-bridge/) 是同一个思路的两条实现，区别只在「谁发起会话」：

- **Discord 那条**：herdr 插件形态，频道映射成 workspace，线程拉起 agent
- **飞书这条**：pi 扩展形态，飞书侧的每个聊天 → 一个新的 pi 会话

底层的 pi-lark-bot 是第三方的，不是我们写的；本目录维护的是**我们对它的改动、启动方式、和踩过的坑**。

## 结构

```
pi-lark-bridge/
  README.md                  ← 你在这里
  01-环境连接.md              飞书应用怎么建、权限怎么批、白名单怎么放行
  02-表情回应.md              收到消息立刻贴 ✅（我们对上游的改动）
  03-多会话.md                一个聊天里开多个 agent（/new · /list · /switch · /close）
  附录-踩过的坑.md            踩过的坑与结论

  source/                   上游 pi-lark-bot 的源码快照，含我们的改动，可直接编辑
  extensions/               我们对上游的全部改动
    pi-lark-bridge.patch      deploy.sh 每次自动导出（对着 based-on.txt 那个 commit）
    based-on.txt
  scripts/
    check.sh                部署前的闸门：tsc --noEmit + 单元测试
    herdr-lark-launch.sh    前台 Ghostty 里启动/附着 herdr 会话
    deploy.sh               检查 → 把 source/ 同步到安装位置 → 重新导出 patch
    status.sh               一眼看清当前状态
```

## 各部分在哪

| 东西 | 位置 |
|---|---|
| 我们的源码快照 | 本目录 `source/` |
| pi 实际加载的扩展 | `~/.pi/agent/git/github.com/fyang93/pi-lark-bot` |
| 凭据 / 白名单 / 会话历史 / 会话编号 | `<项目>/.pi/lark-bot/`（自动 gitignore） |
| herdr 会话 | `~/.config/herdr/sessions/lark-local/` |
| 启动器 | 本目录 `scripts/herdr-lark-launch.sh` |

凭据是本目录**之外**的：它跟着你启用机器人的那个项目走，不在这个仓库里。

## 快速开始

前提：Node 22+、pi 0.85.1+（实测 1.0.4）、herdr 0.9+（实测 0.9.1）。

先装扩展：

```bash
pi install git:github.com/fyang93/pi-lark-bot
```

改代码的流程（`source/` 才是我们维护的版本）：

```bash
cd pi-lark-bridge
./scripts/check.sh           # tsc + 单元测试，必须先全绿
./scripts/deploy.sh          # 先看 dry-run（-i 逐文件列出差异）
./scripts/deploy.sh --go     # 部署：检查 → 同步 → 重新导出 patch
```

> 类型检查不是可选项。有一次 26 行改动里漏了一个常量定义，`tsc` 从没跑过，结果是**消息照收、回复一条没有**（详见 [`02-表情回应.md`](02-表情回应.md) 与[附录](附录-踩过的坑.md)第八条）。deploy 现在默认先跑 `check.sh`，不过就不部署。

拉起带飞书面板的 herdr 会话：

```bash
open -na Ghostty --args -e "$PWD/scripts/herdr-lark-launch.sh"
```

然后在那个面板的 pi 里：

```
/lark-bot link     # 扫码建机器人或选已有应用
/lark-bot on       # 开始监听
```

详细步骤见 [`01-环境连接.md`](01-环境连接.md)。

## 上游更新之后

`pi update --extensions` 会把安装位置重新拉成上游版本，我们的改动就没了。恢复办法：

```bash
cd ~/.pi/agent/git/github.com/fyang93/pi-lark-bot
git apply /path/to/pi-lark-bridge/extensions/pi-lark-bridge.patch
```

patch 覆盖我们的**全部**改动（表情回应 + 多会话），由 `deploy.sh --go` 每次自动重新导出，基线 commit 记在 `extensions/based-on.txt`。上游改动大时可能需要手工合并。更省事的做法是直接用本目录的 `source/` 覆盖回去：`./scripts/deploy.sh --go`。
