# dlna-cast

把音视频文件投到局域网里的 DLNA 播放设备（智能电视、投影仪、机顶盒、游戏主机）。
**是推流，不是屏幕镜像。**

## 它解决什么问题

- 很多播放器和客户端根本不提供「投到电视」：macOS 上的 B站客户端拆包后在 `app.asar` 里搜 `投屏`/`upnp`/`AirPlay`/`castDevice` 是 0 命中
- 屏幕镜像（AirPlay 镜像 / Miracast）把整块屏幕编码压过去，画质音质都要二次损失，还占着电脑不能干别的
- DLNA 推流是让**设备自己去拉文件**：画质无损、电脑只当文件服务器、进度条能拖、可以连续播

## 原理：两步

- 本机起一个支持 HTTP Range 的文件服务（`range_server.py`）
- 用 UPnP AVTransport 把文件 URL 告诉设备（`dlna_cast.py`）

之后设备自己来拉流、解码、显示。由此推出一条使用纪律：

> **本机进程必须活着。** 它一退出，文件服务就停，设备立刻拉不到流。
> 不经过任何第三方服务器，断外网也能播，只要设备和你本机在同一局域网。

## 依赖

Python 3.8+，**纯标准库，无第三方包**。
可选 `ffprobe`（有的话能读出总时长，连播切歌判断更准；没有也能跑）。

## 快速开始

```bash
# 1. 先看看局域网里有哪些能投的设备
python3 dlna_cast.py discover

# 2. 投一个文件（默认投完保持服务，Ctrl-C 结束）
python3 dlna_cast.py cast ~/Movies/片子.mp4 --title "片名" --device 当贝

# 3. 连播多个文件
python3 dlna_cast.py playlist a.mp4 b.mp4 c.mp4 --device 小米

# 4. 控制
python3 dlna_cast.py volume 20 --device 当贝
python3 dlna_cast.py control pause --device 当贝
python3 dlna_cast.py status --device 当贝
```

`--device` 可以放在子命令前面或后面，取值是设备名 / 型号 / IP 的片段。

## 命令

| 命令 | 作用 |
| --- | --- |
| `discover` | SSDP 扫描局域网里的播放设备（`--json` 输出机器可读格式） |
| `cast <文件>` | 投单个文件；默认保持文件服务直到 Ctrl-C |
| `playlist <文件...>` | 连续播放多个文件 |
| `serve --root <目录>` | 只起文件服务，常驻；配合 `cast --url` 使用 |
| `control <动作>` | `play` / `pause` / `stop` / `next` / `prev` / `seek 00:12:00` |
| `volume [值]` | 查询或设置音量，支持 `+10` / `-10` 相对调整 |
| `status` | 查看状态、进度、音量、当前资源 |

常用参数：`--timeout` 扫描秒数、`--port` 文件服务端口、`--root` 服务根目录、
`--url` 用外部已有的文件服务、`--dry-run` 只打印不推送、`--verbose` 打访问日志。

## 连播是怎么做的

Android TV 系设备的 DLNA 实现差异很大，单靠一种机制都不稳，所以两条腿走路：

- 先尝试 `SetNextAVTransportURI` 预排队，设备支持的话能无缝续播
- 同时轮询 `GetTransportInfo` / `GetPositionInfo`：状态变成 `STOPPED`、或位置到达总时长、
  或位置连续多次不动（有些设备播完了也不报 STOPPED），就判定当前曲目结束
- 结束时再查一次设备当前 URI：如果设备已经自己切到下一首就不重复推，否则手动推下一首

用 `--no-queue` 可以关掉预排队，纯轮询切歌。

## 为什么非得支持 Range

DLNA 播放器拉流时会发 `Range` 请求，用来秒开和拖动进度条。
Python 自带的 `http.server` **不支持 Range**，一律返回 200 + 整个文件，
结果就是进度条拖不动、大文件还可能中途断流。

`range_server.py` 补上了 RFC 7233 的语义：`206 Partial Content` + `Content-Range`，
并带上 DLNA 的 `transferMode.dlna.org` / `contentFeatures.dlna.org` 头，
让设备愿意直接流式播放。实测 `bytes=0-2047`、`bytes=1000-1999`、`bytes=-512`、
`bytes=1000000-` 四种写法都返回正确的 206，越界返回 416。

## 踩过的坑

- **设备发现了但拉不到流**：多数是本机防火墙挡住了文件服务端口；其次是本机有多网卡或挂了 VPN，
  报出去的 IP 设备路由不到。本项目用「UDP connect 到设备地址再取本机地址」来挑正确网卡
- **进度条拖不动**：文件服务不支持 Range（见上一节）
- **端口被占用**：会自动改用系统分配的空闲端口，实际端口会在输出里打印
- **SOAP 响应解析**：不同设备的命名空间前缀不一样（有的带 `u:` 有的不带），
  所以标签匹配必须容忍前缀，不能用严格的 XML 解析器硬啃
- **`--device` 放在子命令后面报 unrecognized**：argparse 的父子解析器会互相覆盖默认值。
  这里用 `default=argparse.SUPPRESS` 让子解析器「没写就不覆盖」，缺省值在 `main()` 里补
- **`cast` 不能推完就退出**：一开始设计成推完打印状态就结束，结果是设备刚起播、文件服务就没了。
  现在默认保持进程存活，只想推送用 `--no-wait`（前提是你另有常驻文件服务）

## 已验证

- **当贝 F3 投影**（`当贝 MediaRenderer`）：投流、音量读写、连播、`seek` 均正常
- **Xbox One**：可发现，具备 AVTransport / RenderingControl 服务
- **小米电视**（`hyperDLNA`）：可发现

## 文件

- `dlna_cast.py` —— 主程序：设备发现、投屏、连播、控制
- `range_server.py` —— 支持 Range 的 HTTP 文件服务，也可单独当静态文件服务器用
