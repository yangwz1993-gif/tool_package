#!/bin/bash
# herdr-lark-launch.sh —— 前台 Ghostty 里启动/附着飞书用的 herdr 会话
#
# 用法：open -na Ghostty --args -e /path/to/herdr-lark-launch.sh
#
# 为什么需要这个包装脚本（而不是直接 `ghostty -e herdr --session lark-local`）：
# herdr 默认拒绝嵌套运行。如果启动它的 shell 本身就在某个 herdr 会话里
# （比如从 Discord 那条链路发起的命令），HERDR_ENV 等变量会被继承，
# herdr 会直接报 "nested herdr is disabled by default." 然后退出，
# 于是没有任何客户端附着到会话上，panes 只能用 80x40 的默认尺寸渲染，
# 长内容（例如授权二维码下方的链接）会被裁掉。
#
# 顺带清掉从别的会话继承来的 PI_* 上下文变量，避免飞书面板读到
# Discord 桥的东西。三个模型相关的变量故意保留，让飞书面板沿用你平时
# 的设置；想让它独立，把下面 KEEP_MODEL_ENV 改成 0。

set -u

KEEP_MODEL_ENV="${KEEP_MODEL_ENV:-1}"

HERDR_BIN="${HERDR_BIN:-$HOME/homebrew/bin/herdr}"
SESSION="${LARK_HERDR_SESSION:-lark-local}"

# 1) 清掉「我在 herdr 里」的标记，否则 herdr 拒绝嵌套启动
for v in $(env | sed -n 's/^\(HERDR_[A-Z_]*\)=.*/\1/p'); do
  unset "$v"
done

# 2) 清掉从别的会话继承来的 pi 上下文
unset PI_DISCORD_EXTENSION
unset PI_SESSION_ID PI_SESSION_FILE
for v in $(env | sed -n 's/^\(PI_SUBAGENT_[A-Z_]*\)=.*/\1/p'); do
  unset "$v"
done
for v in $(env | sed -n 's/^\(PI_LARK_BOT_[A-Z_]*\)=.*/\1/p'); do
  unset "$v"
done

# 3) 模型设置：默认保留继承，让飞书面板跟你平时用的一致
if [ "$KEEP_MODEL_ENV" != "1" ]; then
  unset PI_MODEL PI_PROVIDER PI_REASONING_LEVEL PI_CODING_AGENT
fi

exec "$HERDR_BIN" --session "$SESSION"
