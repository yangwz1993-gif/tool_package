---
name: room-model-reload
description: >
  查精确模型名、给房间换模型、reload 扩展与配置的操作手册。当用户要求「换个模型」
  「切到某个模型」「查有哪些模型」「reload」「重载扩展」「让配置生效」时使用。
  覆盖 shell（herdr pane run）与 Discord（!! 前缀）两条路径，含两个会静默出错的坑：
  同名模型跨供应商会切错并扣错钱、模型表是启动时快照导致新凭证不生效。
  不触发：只调 API 不改模型、纯代码修改、与模型选择无关的普通提问。
---

# 房间：查模型名 / 换模型 / reload

先记住心智模型：**一个 Discord 子区 = 一个 herdr pane = 一个独立的 pi 进程**。
模型是**每个进程自己**的，改一个房间不影响别的房间。

## 查精确模型名

    pi --list-models            # 全量
    pi --list-models <关键字>   # 过滤

输出有 `provider` 和 `model` 两列，**两列拼起来才是完整引用**。

同一个模型在不同供应商下的条目是**不同的东西**，走不同账户：

    provider    model
    openrouter  xiaomi/mimo-v2.6-pro
    xiaomi      mimo-v2.6-pro

`--list-models` 还会给出 context / max-out / thinking / images，需要判断能力时看这几列。

## 换模型

**shell 路径**（对着目标 pane 发命令）：

    herdr pane run <pane_id> "/model <provider>/<model_id>"

**Discord 路径**（在那个子区里发，`!!` 前缀是「原样敲进终端」）：

    !!/model <provider>/<model_id>

**启动时就指定**：

    herdr agent start <name> --kind pi --pane <pane_id> -- --model <provider>/<model_id>

思考深度跟在冒号后：`<provider>/<model_id>:high`，可选 `off / minimal / low / medium / high / xhigh / max`。

`/model` **当场生效**，也不受 agent 是否在忙的限制。

## 铁律：必须用精确的 provider/id

用关键字会弹出 TUI 选择器，而**选择器在 Discord 里点不了**，房间会卡住。
永远写全 `provider/model_id`。

## 铁律：切完一定要看 provider

pi 解析模型引用的顺序是：规范形式 `${provider}/${id}` 精确相等 → 按第一个斜杠切开找 → 退化成只按 id 全等找。

危险在于有些供应商的模型 **id 字面就叫 `xiaomi/mimo-v2.6-pro`**（带斜杠）。当目标 provider 不在模型表里时，前两步落空，第三步就会命中那个同名条目。

**结果是静默切错供应商，扣错账户的钱。** 从聊天记录里完全看不出来，因为字符串一样。

区分只有一处：状态栏括号里的 provider 名。

    (xiaomi) mimo-v2.6-pro              ← 对
    (openrouter) xiaomi/mimo-v2.6-pro   ← 错

看 pane 状态栏：

    herdr pane read <pane_id> --lines 3

## 铁律：加了新 key 先 reload

pi 的可用模型表是**进程启动时**的快照，依据当时 `auth.json` 里有哪些凭证。

所以往 `auth.json` 新加了 provider 之后，在**早就跑着的房间**里 `/model` 会认不出它，进而掉进上一条的坑。

顺序不能反：

    herdr pane run <pane_id> "/reload"
    herdr pane run <pane_id> "/model <provider>/<model_id>"

## reload

    herdr pane run <pane_id> "/reload"
    # Discord 里
    !!/reload

reload 会重载扩展、重读认证与配置，副作用是扩展的运行时状态被重置。

**自己 reload 自己必须延迟。** pi 在输出中会硬拒，提示「等当前响应结束」。所以 agent 想给自己换扩展要排到回合之后：

    nohup sh -c 'sleep 60; herdr pane run "$HERDR_PANE_ID" "/reload"' >/dev/null 2>&1 &

`$HERDR_PANE_ID` 在 agent 环境里现成，指它自己所在的 pane。

## 定位 pane

    herdr agent list                    # pane_id / name / status / cwd
    herdr agent get <name>              # 更详细，含会话文件路径
    herdr pane list                     # 所有 pane

不要按「编号最小的 pane」去猜某个 agent 的位置，会猜错。按 `pane_id` 或 `agent_session.value` 精确匹配。

`herdr tab get` **不返回 pane**，别用它找 pane。

## 虚拟模型的 `~` 前缀

有些模型 id 本身以 `~` 开头，那是虚拟模型标记，**是 id 字面的一部分，写引用时必须带上**。

## 换模型后的正常现象

切换会清空缓存，第一轮出现 `Cache miss after model switch` 是预期行为，不是故障。

## 开销记录

pi 按模型目录里的 `cost` 字段自动算钱，不用配。`cost` 形如 `{input, output, cacheRead, cacheWrite}`，单位是每百万 token。

`cost` 为 0 是**没定价**，不是免费。DeepSeek 有峰谷价，谷时是高峰一半，pi 一律按高峰算，谷时会高估一倍。
