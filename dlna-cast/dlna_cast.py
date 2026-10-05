#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
通用 DLNA / UPnP 投屏工具（推流，不是屏幕镜像）。

原理
    分两步：
      1. 本机跑一个支持 Range 的 HTTP 文件服务（range_server.py）；
      2. 用 UPnP AVTransport 把文件 URL 告诉播放设备，设备自己去拉流解码。
    所以画质不受投屏协议二次压缩、本机不参与解码，代价是必须保持文件服务在跑。

特点
    - 设备自动发现（SSDP），不需要预先知道 IP / UUID / 控制端口
    - 自动挑正确的本机网卡地址（多网卡、有 VPN 时也不会发错 IP）
    - 单文件投屏、播放列表连播（SetNextAVTransportURI 预排队 + 轮询兜底）
    - 播放控制 / 音量 / 静音 / 状态查询
    - 纯标准库，无第三方依赖

示例
    python3 dlna_cast.py discover
    python3 dlna_cast.py cast movie.mp4 --title "电影名" --watch
    python3 dlna_cast.py playlist a.mp4 b.mp4 c.mp4
    python3 dlna_cast.py volume 20
    python3 dlna_cast.py status
"""

import argparse
import json
import os
import re
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from xml.sax.saxutils import escape as _xml_escape

try:
    from range_server import serve_in_thread
except ImportError:  # 允许从别处直接调用
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from range_server import serve_in_thread

__version__ = "1.0.0"

SSDP_ADDR = ("239.255.255.250", 1900)
DEFAULT_SEARCH_TARGETS = [
    "urn:schemas-upnp-org:device:MediaRenderer:1",
    "urn:schemas-upnp-org:service:AVTransport:1",
]
DEFAULT_PORT = 8899

MIME_BY_EXT = {
    ".mp4": "video/mp4", ".m4v": "video/mp4", ".mkv": "video/x-matroska",
    ".webm": "video/webm", ".avi": "video/x-msvideo", ".mov": "video/quicktime",
    ".ts": "video/mp2t", ".mpg": "video/mpeg", ".mpeg": "video/mpeg",
    ".flv": "video/x-flv", ".wmv": "video/x-ms-wmv",
    ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac",
    ".flac": "audio/flac", ".wav": "audio/wav", ".ogg": "audio/ogg",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".gif": "image/gif", ".bmp": "image/bmp",
}

# UPnP AVTransport 常见错误码，转成人话
UPNP_ERRORS = {
    "401": "无效动作，设备不支持这个操作",
    "402": "参数错误",
    "501": "动作执行失败",
    "701": "当前状态下不允许这个转换（例如已经在播放时又按播放）",
    "702": "当前状态下不允许 seek",
    "704": "不支持的跳转模式",
    "705": "跳转目标超出范围",
    "710": "设备不支持该 seek 模式",
    "711": "seek 目标非法",
    "712": "不支持的播放速度",
    "713": "不支持的播放模式",
    "714": "设备不支持该 MIME 类型（可能是格式不兼容）",
    "715": "资源被占用 / 内容忙",
    "716": "资源不存在（设备拉不到这个 URL，检查防火墙和本机 IP）",
    "718": "InstanceID 非法",
    "720": "设备无法播放该资源",
    "724": "不支持的传输协议",
}


# ---------------------------------------------------------------- 小工具

def die(msg, code=1):
    print(msg, file=sys.stderr)
    sys.exit(code)


def xml_attr(value):
    return _xml_escape(str(value), {'"': "&quot;", "'": "&apos;"})


def grab(xml, tag, default=None):
    """从 SOAP 响应里取标签文本（容忍命名空间前缀）。"""
    if not xml:
        return default
    pat = r"<(?:[A-Za-z0-9_.-]+:)?%s(?:\s[^>]*)?>(.*?)</(?:[A-Za-z0-9_.-]+:)?%s>" % (re.escape(tag), re.escape(tag))
    m = re.search(pat, xml, re.S)
    if not m:
        return default
    from xml.sax.saxutils import unescape
    return unescape(m.group(1)).strip()


def upnp_error_text(xml):
    """把 SOAP Fault 里的 UPnPError 翻成人话。"""
    code = grab(xml, "errorCode")
    desc = grab(xml, "errorDescription")
    if code:
        human = UPNP_ERRORS.get(str(code))
        return "UPnP 错误 %s%s%s" % (code, (" · " + human) if human else "", (" · " + desc) if desc else "")
    if xml:
        return re.sub(r"\s+", " ", xml.strip())[:200]
    return "未知错误"


def parse_hms(text):
    """'00:03:41' / '1:02:03.5' → 秒。"""
    if not text:
        return None
    parts = text.strip().split(":")
    try:
        nums = [float(p) for p in parts]
    except ValueError:
        return None
    total = 0.0
    for n in nums:
        total = total * 60 + n
    return total


def fmt_hms(seconds):
    if seconds is None:
        return "?"
    seconds = int(seconds)
    return "%02d:%02d:%02d" % (seconds // 3600, (seconds % 3600) // 60, seconds % 60)


def mime_for(path):
    return MIME_BY_EXT.get(os.path.splitext(path)[1].lower(), "application/octet-stream")


def local_ip_for(host):
    """挑一个能路由到 host 的本机 IPv4（多网卡/有 VPN 时用得上）。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect((host, 9))
        return s.getsockname()[0]
    except Exception:
        try:
            return socket.gethostbyname(socket.gethostname())
        except Exception:
            return "127.0.0.1"
    finally:
        s.close()


# ---------------------------------------------------------------- 设备发现

def ssdp_search(timeout=3.0, targets=None):
    """发 SSDP M-SEARCH，收集响应里的 LOCATION。返回 {location: headers}。"""
    found = {}
    for st in (targets or DEFAULT_SEARCH_TARGETS):
        msg = "\r\n".join([
            "M-SEARCH * HTTP/1.1",
            "HOST: 239.255.255.250:1900",
            'MAN: "ssdp:discover"',
            "MX: 2",
            "ST: %s" % st,
            "", "",
        ]).encode("utf-8")
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
        except OSError:
            pass
        sock.settimeout(timeout)
        try:
            sock.sendto(msg, SSDP_ADDR)
            deadline = time.time() + timeout
            while time.time() < deadline:
                try:
                    data, addr = sock.recvfrom(65535)
                except socket.timeout:
                    break
                headers = {}
                for line in data.decode("utf-8", "ignore").split("\r\n")[1:]:
                    if ":" in line:
                        k, v = line.split(":", 1)
                        headers[k.strip().lower()] = v.strip()
                loc = headers.get("location")
                if loc:
                    found.setdefault(loc, headers)
        finally:
            sock.close()
    return found


def parse_description(xml, location):
    """解析设备描述 XML，抽出名称、型号、UDN 和各服务的 controlURL。"""
    services = {}
    for block in re.findall(r"<service\b.*?</service>", xml, re.S | re.I):
        stype = grab(block, "serviceType")
        curl = grab(block, "controlURL")
        if stype and curl:
            services[stype] = urllib.parse.urljoin(location, curl)
    return {
        "location": location,
        "friendly_name": grab(xml, "friendlyName") or "(未命名)",
        "manufacturer": grab(xml, "manufacturer") or "",
        "model_name": grab(xml, "modelName") or "",
        "udn": grab(xml, "UDN") or "",
        "services": services,
    }


def discover(timeout=3.0, targets=None):
    """SSDP 扫描 + 抓设备描述。返回设备字典列表（同一 UDN 去重）。"""
    devices, seen = [], set()
    for location in ssdp_search(timeout, targets):
        try:
            with urllib.request.urlopen(location, timeout=5) as resp:
                xml = resp.read().decode("utf-8", "ignore")
        except Exception:
            continue
        dev = parse_description(xml, location)
        key = dev["udn"] or location
        if key in seen:
            continue
        seen.add(key)
        devices.append(dev)
    # 能播的排前面
    devices.sort(key=lambda d: (pick_service(d["services"], "AVTransport")[1] is None,
                                (d["friendly_name"] or "").lower()))
    return devices


def pick_service(services, name):
    """按服务名（不带版本）找 (serviceType, controlURL)。"""
    prefix = "urn:schemas-upnp-org:service:%s:" % name.lower()
    for stype, curl in services.items():
        if stype.lower().startswith(prefix):
            return stype, curl
    return None, None


def pick_device(devices, query=None):
    if not devices:
        die("没有发现任何 DLNA 播放设备。\n"
            "  排查：① 设备和本机在同一局域网/同一 VLAN？\n"
            "        ② 路由器是否开了 AP 隔离（客户端隔离）？\n"
            "        ③ 加大扫描时间：--timeout 6")
    playable = [d for d in devices if pick_service(d["services"], "AVTransport")[1]]
    pool = playable or devices
    if query:
        q = query.strip().lower()
        matched = [d for d in pool
                   if q in (d["friendly_name"] or "").lower()
                   or q in (d["model_name"] or "").lower()
                   or q in d["location"].lower()
                   or q in (d["udn"] or "").lower()]
        if not matched:
            die("没有匹配 %r 的设备。可用的有：\n%s" % (query, device_lines(pool)))
        exact = [d for d in matched if (d["friendly_name"] or "").lower() == q]
        if len(exact) == 1:
            return exact[0]
        if len(matched) > 1:
            print("匹配到 %d 台设备，用第一台：%s" % (len(matched), matched[0]["friendly_name"]))
        return matched[0]
    if len(pool) == 1:
        return pool[0]
    die("发现多台可投屏设备，请用 --device 指定其中一台：\n%s" % device_lines(pool))


def device_lines(devices):
    lines = []
    for i, d in enumerate(devices):
        has_av = "可投屏" if pick_service(d["services"], "AVTransport")[1] else "无 AVTransport"
        host = urllib.parse.urlparse(d["location"]).hostname or "?"
        lines.append("  [%d] %-24s %-18s %-14s %s"
                     % (i, d["friendly_name"][:24], d["model_name"][:18], host, has_av))
    return "\n".join(lines)


# ---------------------------------------------------------------- 播放器封装

class Renderer:
    """一个 UPnP AV 播放设备的控制句柄。所有方法返回 (ok, 原始响应)。"""

    def __init__(self, dev, timeout=10):
        self.dev = dev
        self.timeout = timeout
        self.services = dev["services"]
        self.av_type, self.av_url = pick_service(self.services, "AVTransport")
        self.rc_type, self.rc_url = pick_service(self.services, "RenderingControl")
        self.av_ver = self.av_type.rsplit(":", 1)[-1] if self.av_type else "1"
        self.rc_ver = self.rc_type.rsplit(":", 1)[-1] if self.rc_type else "1"
        self.host = urllib.parse.urlparse(dev["location"]).hostname or "127.0.0.1"

    def __repr__(self):
        return "<Renderer %s @%s>" % (self.dev["friendly_name"], self.host)

    def _soap(self, service, version, url, action, extra=""):
        if not url:
            return False, "设备没有暴露 %s 服务" % service
        body = ('<u:%(a)s xmlns:u="urn:schemas-upnp-org:service:%(s)s:%(v)s">'
                "<InstanceID>0</InstanceID>%(x)s</u:%(a)s>"
                % {"a": action, "s": service, "v": version, "x": extra})
        env = ('<?xml version="1.0" encoding="utf-8"?>'
               '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
               's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
               "<s:Body>%s</s:Body></s:Envelope>" % body)
        req = urllib.request.Request(
            url, data=env.encode("utf-8"), method="POST",
            headers={
                "Content-Type": 'text/xml; charset="utf-8"',
                "SOAPAction": '"urn:schemas-upnp-org:service:%s:%s#%s"' % (service, version, action),
                "User-Agent": "UPnP/1.1 dlna-cast/%s" % __version__,
            })
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return True, resp.read().decode("utf-8", "ignore")
        except urllib.error.HTTPError as exc:
            return False, exc.read().decode("utf-8", "ignore") or ("HTTP %d" % exc.code)
        except Exception as exc:
            return False, "%s: %s" % (type(exc).__name__, exc)

    def av(self, action, extra=""):
        return self._soap("AVTransport", self.av_ver, self.av_url, action, extra)

    def rc(self, action, extra=""):
        return self._soap("RenderingControl", self.rc_ver, self.rc_url, action, extra)

    # ---- 传输控制 ----
    def play(self, speed="1"):
        return self.av("Play", "<Speed>%s</Speed>" % speed)

    def pause(self):
        return self.av("Pause")

    def stop(self):
        return self.av("Stop")

    def next_track(self):
        return self.av("Next")

    def previous_track(self):
        return self.av("Previous")

    def seek(self, target):
        return self.av("Seek", "<Unit>REL_TIME</Unit><Target>%s</Target>" % target)

    def set_uri(self, uri, meta=""):
        return self.av("SetAVTransportURI",
                       "<CurrentURI>%s</CurrentURI><CurrentURIMetaData>%s</CurrentURIMetaData>"
                       % (_xml_escape(uri), _xml_escape(meta)))

    def set_next_uri(self, uri, meta=""):
        return self.av("SetNextAVTransportURI",
                       "<NextURI>%s</NextURI><NextURIMetaData>%s</NextURIMetaData>"
                       % (_xml_escape(uri), _xml_escape(meta)))

    # ---- 状态读取 ----
    def transport_state(self):
        ok, xml = self.av("GetTransportInfo")
        return grab(xml, "CurrentTransportState") if ok else None

    def position(self):
        ok, xml = self.av("GetPositionInfo")
        if not ok:
            return {}
        return {
            "track": grab(xml, "Track"),
            "duration": grab(xml, "TrackDuration"),
            "rel": grab(xml, "RelTime"),
            "abs": grab(xml, "AbsTime"),
            "uri": grab(xml, "TrackURI"),
        }

    def media_info(self):
        ok, xml = self.av("GetMediaInfo")
        if not ok:
            return {}
        return {"duration": grab(xml, "MediaDuration"), "uri": grab(xml, "CurrentURI")}

    def volume(self):
        ok, xml = self.rc("GetVolume", "<Channel>Master</Channel>")
        val = grab(xml, "CurrentVolume") if ok else None
        return int(val) if val and val.isdigit() else None

    def set_volume(self, value):
        return self.rc("SetVolume", "<Channel>Master</Channel><DesiredVolume>%d</DesiredVolume>" % value)

    def muted(self):
        ok, xml = self.rc("GetMute", "<Channel>Master</Channel>")
        val = grab(xml, "CurrentMute") if ok else None
        return None if val is None else val in ("1", "true", "True")

    def set_mute(self, on):
        return self.rc("SetMute", "<Channel>Master</Channel><DesiredMute>%d</DesiredMute>" % (1 if on else 0))


# ---------------------------------------------------------------- DIDL 元数据

def build_metadata(url, title, mime="video/mp4", artist=None, album=None,
                   subtitle_url=None, subtitle_type="srt"):
    """构造 DIDL-Lite 元数据。设备靠它显示标题、判断类型。"""
    if mime.startswith("video"):
        cls = "object.item.videoItem"
    elif mime.startswith("audio"):
        cls = "object.item.audioItem.musicTrack"
    elif mime.startswith("image"):
        cls = "object.item.imageItem.photo"
    else:
        cls = "object.item"

    parts = [
        '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" '
        'xmlns:dc="http://purl.org/dc/elements/1.1/" '
        'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" '
        'xmlns:sec="http://www.sec.co.kr/">',
        '<item id="0" parentID="-1" restricted="1">',
        "<dc:title>%s</dc:title>" % _xml_escape(title),
        "<upnp:class>%s</upnp:class>" % cls,
    ]
    if artist:
        parts.append("<upnp:artist>%s</upnp:artist>" % _xml_escape(artist))
    if album:
        parts.append("<upnp:album>%s</upnp:album>" % _xml_escape(album))

    proto = ("http-get:*:%s:DLNA.ORG_OP=01;DLNA.ORG_CI=0;"
             "DLNA.ORG_FLAGS=01700000000000000000000000000000" % mime)
    parts.append('<res protocolInfo="%s">%s</res>' % (xml_attr(proto), _xml_escape(url)))

    if subtitle_url:
        parts.append('<sec:CaptionInfoEx sec:type="%s">%s</sec:CaptionInfoEx>'
                     % (xml_attr(subtitle_type), _xml_escape(subtitle_url)))

    parts.append("</item></DIDL-Lite>")
    return "".join(parts)


# ---------------------------------------------------------------- 文件服务

class MediaServer:
    """管理本机的 Range 文件服务。"""

    def __init__(self, root, port=DEFAULT_PORT, quiet=True):
        self.root = os.path.abspath(os.path.expanduser(root))
        self.httpd, self.port, self.thread = serve_in_thread(
            self.root, port=port, quiet=quiet, list_dirs=False)
        self.local_ip = None

    def url_for(self, path, device_host):
        rel = os.path.relpath(os.path.abspath(path), self.root).replace(os.sep, "/")
        self.local_ip = self.local_ip or local_ip_for(device_host)
        return "http://%s:%d/%s" % (self.local_ip, self.port, urllib.parse.quote(rel))

    def close(self):
        try:
            self.httpd.shutdown()
            self.httpd.server_close()
        except Exception:
            pass


# ---------------------------------------------------------------- 子命令

def cmd_discover(args):
    devices = discover(timeout=args.timeout)
    if args.json:
        print(json.dumps(devices, ensure_ascii=False, indent=2))
        return 0
    if not devices:
        print("没有发现 DLNA 设备。")
        print("提示：确认设备和本机在同一局域网，且路由器没有开启客户端隔离（AP isolation）。")
        return 1
    print("发现 %d 台设备：" % len(devices))
    print(device_lines(devices))
    print()
    print("投屏示例：python3 %s cast 视频.mp4 --device \"%s\""
          % (os.path.basename(sys.argv[0]), devices[0]["friendly_name"]))
    return 0


def _prepare_items(args, renderer):
    """把命令行给的文件路径转成 [{path,url,meta,title,duration}]。"""
    paths = []
    for f in args.files:
        p = os.path.abspath(os.path.expanduser(f))
        if not os.path.isfile(p):
            die("文件不存在：%s" % p)
        paths.append(p)

    root = os.path.abspath(os.path.expanduser(args.root)) if args.root else _common_root(paths)
    server = None
    if args.url:
        base = args.url.rstrip("/") + "/"
    else:
        server = MediaServer(root, port=args.port, quiet=not args.verbose)
        base = None

    items = []
    for p in paths:
        url = (base + urllib.parse.quote(os.path.basename(p))) if base else server.url_for(p, renderer.host)
        mime = mime_for(p)
        title = args.title if (args.title and len(paths) == 1) else os.path.splitext(os.path.basename(p))[0]
        items.append({
            "path": p,
            "url": url,
            "mime": mime,
            "title": title,
            "meta": build_metadata(url, title, mime, artist=args.artist, album=args.album),
            "duration": _probe_duration(p),
        })
    return items, server


def _common_root(paths):
    dirs = [os.path.dirname(p) for p in paths]
    try:
        return os.path.commonpath(dirs)
    except ValueError:
        return dirs[0]


def _probe_duration(path):
    """尽量拿时长，用于判断播放结束。没 ffprobe 就返回 None。"""
    import shutil
    import subprocess
    if not shutil.which("ffprobe"):
        return None
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", path],
            capture_output=True, text=True, timeout=10).stdout.strip()
        return float(out) if out else None
    except Exception:
        return None


def _push(renderer, item, quiet=False):
    """把某个 item 设为当前播放内容并开始播放。"""
    renderer.stop()
    time.sleep(0.4)
    ok, resp = renderer.set_uri(item["url"], item["meta"])
    if not ok:
        die("SetAVTransportURI 失败：%s" % upnp_error_text(resp))
    time.sleep(0.6)
    ok, resp = renderer.play()
    if not ok:
        die("Play 失败：%s" % upnp_error_text(resp))
    if not quiet:
        print("  正在播放：%s" % item["title"])


def _wait_end(renderer, duration, poll=2.0, stall_limit=4, quiet=False):
    """等当前曲目播完。返回结束原因。"""
    last_rel, stall = None, 0
    deadline = time.time() + (duration * 2 + 180 if duration else 6 * 3600)
    while time.time() < deadline:
        time.sleep(poll)
        state = renderer.transport_state()
        pos = renderer.position()
        rel = parse_hms(pos.get("rel"))
        dur = parse_hms(pos.get("duration")) or duration
        if not quiet and rel is not None:
            sys.stdout.write("    进度 %s / %s   \r" % (fmt_hms(rel), fmt_hms(dur) if dur else "?"))
            sys.stdout.flush()
        if state in (None, "STOPPED", "NO_MEDIA_PRESENT"):
            return "ended"
        if dur and rel is not None and rel >= dur - 1.0:
            return "ended"
        if rel is not None and last_rel is not None and abs(rel - last_rel) < 0.5:
            stall += 1
            if stall >= stall_limit:
                return "stalled"
        else:
            stall = 0
        last_rel = rel
    return "timeout"


def _same_uri(current, target):
    if not current or not target:
        return False
    a = urllib.parse.unquote(current).lower()
    b = urllib.parse.unquote(target).lower()
    name = os.path.basename(b)
    return b in a or (name and a.endswith(name))


def cmd_cast(args):
    file_path = os.path.abspath(os.path.expanduser(args.file))
    if not os.path.isfile(file_path):
        die("文件不存在：%s" % file_path)
    args.files = [args.file]
    args.root = getattr(args, "root", None)
    args.url = getattr(args, "url", None)
    args.verbose = getattr(args, "verbose", False)

    devices = discover(timeout=args.timeout)
    dev = pick_device(devices, args.device)
    renderer = Renderer(dev)
    print("设备：%s (%s @%s)" % (dev["friendly_name"], dev["model_name"] or "?", renderer.host))
    if not renderer.av_url:
        die("这台设备没有 AVTransport 服务，无法作为投屏目标。")

    items, server = _prepare_items(args, renderer)
    item = items[0]
    print("文件：%s  (%s)" % (item["path"], item["mime"]))
    print("地址：%s" % item["url"])

    if args.dry_run:
        print("\n--dry-run：只打印不推送。DIDL 元数据：\n%s" % item["meta"])
        if server:
            server.close()
        return 0

    _push(renderer, item)
    time.sleep(2)
    print(_status_text(renderer))

    if args.no_wait:
        if server:
            print("\n注意：--no-wait 会让本进程退出，随之文件服务也停，设备会拉不到流。\n"
                  "     除非你另有常驻文件服务（用服务端的 --url 指定），否则请去掉 --no-wait。")
        return 0

    # 关键：进程必须活着，设备才拉得到流（本机就是它的信号源）
    if not server:
        print("\n用的是外部 --url，无需保持本进程；播放不受影响。")
        return 0
    print("\n文件服务运行中，设备正在从这里拉流。按 Ctrl-C 结束（会中断播放）。")
    try:
        while True:
            time.sleep(5)
            state = renderer.transport_state()
            pos = renderer.position()
            rel = parse_hms(pos.get("rel"))
            dur = parse_hms(pos.get("duration")) or item["duration"]
            if args.watch:
                print("  %s  进度 %s / %s" % (state or "?", fmt_hms(rel), fmt_hms(dur) if dur else "?"))
            if state in ("STOPPED", "NO_MEDIA_PRESENT"):
                print("  播放结束。")
                break
    except KeyboardInterrupt:
        print("\n已退出。播放会随文件服务停止而中断。")
    finally:
        server.close()
    return 0


def cmd_playlist(args):
    args.files = args.files
    args.root = getattr(args, "root", None)
    args.url = getattr(args, "url", None)
    args.verbose = getattr(args, "verbose", False)

    devices = discover(timeout=args.timeout)
    dev = pick_device(devices, args.device)
    renderer = Renderer(dev)
    print("设备：%s @%s" % (dev["friendly_name"], renderer.host))

    items, server = _prepare_items(args, renderer)
    print("共 %d 首/集，总时长约 %s" % (
        len(items),
        fmt_hms(sum(i["duration"] or 0 for i in items)) if any(i["duration"] for i in items) else "未知"))
    for n, it in enumerate(items, 1):
        print("  %2d. %s%s" % (n, it["title"],
                               ("  [%s]" % fmt_hms(it["duration"])) if it["duration"] else ""))

    if args.dry_run:
        for it in items:
            print("\n%s\n  url  = %s\n  meta = %s" % (it["title"], it["url"], it["meta"]))
        if server:
            server.close()
        return 0

    try:
        renderer.stop()
        time.sleep(0.5)
        _push(renderer, items[0])
        idx = 0
        while idx < len(items):
            if idx + 1 >= len(items):
                _wait_end(renderer, items[idx]["duration"], quiet=args.quiet)
                break
            nxt = items[idx + 1]
            queued = False
            if not args.no_queue:
                ok, _ = renderer.set_next_uri(nxt["url"], nxt["meta"])
                queued = ok
            reason = _wait_end(renderer, items[idx]["duration"], quiet=args.quiet)
            idx += 1
            cur = items[idx]
            advanced = _same_uri(renderer.media_info().get("uri"), cur["url"])
            if advanced:
                print("  %s 已自动接上：%s" % ("（预排队生效）" if queued else "", cur["title"]))
            else:
                if reason == "stalled" and not args.quiet:
                    print("  （位置长时间不动，按已结束处理）")
                _push(renderer, cur)
        print("\n全部播完。")
    except KeyboardInterrupt:
        print("\n已中断（播放继续；本进程退出后文件服务停止）。")
    return 0


def cmd_serve(args):
    from range_server import ThreadingHTTPServer, make_handler
    root = os.path.abspath(os.path.expanduser(args.root))
    if not os.path.isdir(root):
        die("目录不存在：%s" % root)
    httpd = ThreadingHTTPServer(("0.0.0.0", args.port),
                                make_handler(root, list_dirs=args.list_dirs, quiet=False))
    print("服务目录：%s" % root)
    print("监听：http://0.0.0.0:%d/   （Ctrl-C 退出）" % httpd.server_address[1])
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        httpd.server_close()
    return 0


def cmd_control(args):
    renderer = _connect(args)
    action = args.action.lower()
    if action == "play":
        ok, resp = renderer.play()
    elif action == "pause":
        ok, resp = renderer.pause()
    elif action == "stop":
        ok, resp = renderer.stop()
    elif action in ("next", "下一首"):
        ok, resp = renderer.next_track()
    elif action in ("prev", "previous", "上一首"):
        ok, resp = renderer.previous_track()
    elif action == "seek":
        if not args.value:
            die("seek 需要目标时间，例如：control seek 00:12:00")
        ok, resp = renderer.seek(args.value)
    else:
        die("不支持的动作：%s（可用 play / pause / stop / next / prev / seek）" % action)
    if not ok:
        die("%s 失败：%s" % (action, upnp_error_text(resp)))
    time.sleep(1)
    print(_status_text(renderer))
    return 0


def cmd_volume(args):
    renderer = _connect(args)
    if args.value is None:
        print("当前音量：%s" % renderer.volume())
        return 0
    raw = str(args.value)
    cur = renderer.volume() or 0
    if raw.startswith(("+", "-")):
        target = max(0, min(100, cur + int(raw)))
    else:
        target = max(0, min(100, int(raw)))
    ok, resp = renderer.set_volume(target)
    if not ok:
        die("设置音量失败：%s" % upnp_error_text(resp))
    time.sleep(0.8)
    print("音量：%d → %s" % (target, renderer.volume()))
    return 0


def cmd_status(args):
    renderer = _connect(args)
    print(_status_text(renderer))
    return 0


def _connect(args):
    devices = discover(timeout=args.timeout)
    dev = pick_device(devices, args.device)
    renderer = Renderer(dev)
    if not renderer.av_url and not renderer.rc_url:
        die("这台设备既没有 AVTransport 也没有 RenderingControl，无法控制。")
    return renderer


def _status_text(renderer):
    state = renderer.transport_state()
    pos = renderer.position()
    seg = ["状态：%s" % (state or "未知")]
    if pos.get("duration"):
        seg.append("时长：%s" % pos["duration"])
    if pos.get("rel"):
        seg.append("位置：%s" % pos["rel"])
    vol = renderer.volume()
    if vol is not None:
        seg.append("音量：%d" % vol)
    mute = renderer.muted()
    if mute:
        seg.append("已静音")
    uri = pos.get("uri") or renderer.media_info().get("uri")
    if uri:
        seg.append("资源：%s" % uri[:80])
    return "\n".join(seg)


# ---------------------------------------------------------------- CLI

def build_parser():
    # --device / --timeout 同时挂到主解析器和每个子命令上，
    # 这样 `--device X status` 和 `status --device X` 都能用。
    # 用 SUPPRESS 让子解析器不在缺省时覆盖主解析器的值。
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--device", "-d", default=argparse.SUPPRESS,
                        help="设备名/IP/型号 的片段，留空则自动选（只有一台时）")
    common.add_argument("--timeout", "-t", type=float, default=argparse.SUPPRESS,
                        help="SSDP 扫描秒数（默认 3）")

    p = argparse.ArgumentParser(
        prog="dlna_cast.py",
        parents=[common],
        description="通用 DLNA 投屏工具：本机起 HTTP 文件服务 + UPnP AVTransport 遥控设备拉流",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="示例：\n"
               "  %(prog)s discover\n"
               "  %(prog)s cast 电影.mp4 --title \"片名\" --watch\n"
               "  %(prog)s playlist 1.mp4 2.mp4 3.mp4 --device 当贝\n"
               "  %(prog)s volume +10 --device 当贝\n"
               "  %(prog)s status\n",
    )
    p.add_argument("--version", action="version", version="dlna-cast %s" % __version__)
    sub = p.add_subparsers(dest="command", required=True)

    d = sub.add_parser("discover", parents=[common], help="扫描局域网里的 DLNA 播放设备")
    d.add_argument("--json", action="store_true", help="以 JSON 输出")
    d.set_defaults(func=cmd_discover)

    def add_common(sp):
        sp.add_argument("files", nargs="+", help="要投的文件（可多个）")
        sp.add_argument("--title", help="显示标题（单文件时生效）")
        sp.add_argument("--artist", help="艺人（写进 DIDL 元数据）")
        sp.add_argument("--album", help="专辑（写进 DIDL 元数据）")
        sp.add_argument("--root", help="文件服务根目录（默认取文件所在目录）")
        sp.add_argument("--port", "-p", type=int, default=DEFAULT_PORT, help="文件服务端口（默认 %d）" % DEFAULT_PORT)
        sp.add_argument("--url", help="不自建服务，直接用这个 URL 前缀（比如已有 nginx）")
        sp.add_argument("--dry-run", action="store_true", help="只打印将要发送的内容")
        sp.add_argument("--verbose", "-v", action="store_true", help="打印文件服务的访问日志")

    c = sub.add_parser("cast", parents=[common], help="投单个文件（默认投完保持文件服务，直到 Ctrl-C）")
    add_common(c)
    c.add_argument("--watch", "-w", action="store_true", help="持续打印播放进度")
    c.add_argument("--no-wait", action="store_true",
                   help="推完就退出（仅当你另有常驻文件服务时用）")
    c.set_defaults(func=cmd_cast, _single=True)

    sv = sub.add_parser("serve", parents=[common], help="只起文件服务（常驻；配合 cast --url 使用）")
    sv.add_argument("--root", "-r", required=True, help="要服务的目录")
    sv.add_argument("--port", "-p", type=int, default=DEFAULT_PORT, help="端口（默认 %d）" % DEFAULT_PORT)
    sv.add_argument("--list-dirs", action="store_true", help="允许浏览目录")
    sv.set_defaults(func=cmd_serve)

    pl = sub.add_parser("playlist", parents=[common], help="连续播放多个文件")
    add_common(pl)
    pl.add_argument("--no-queue", action="store_true", help="不用 SetNextAVTransportURI 预排队，纯轮询切歌")
    pl.add_argument("--quiet", "-q", action="store_true", help="不打印逐秒进度")
    pl.set_defaults(func=cmd_playlist)

    ct = sub.add_parser("control", parents=[common], help="播放控制：play / pause / stop / next / prev / seek")
    ct.add_argument("action", help="play | pause | stop | next | prev | seek")
    ct.add_argument("value", nargs="?", help="seek 的目标时间，如 00:12:00")
    ct.set_defaults(func=cmd_control)

    v = sub.add_parser("volume", parents=[common], help="查看或设置音量")
    v.add_argument("value", nargs="?", help="0-100，或 +5 / -5 相对调整；留空则只查询")
    v.set_defaults(func=cmd_volume)

    s = sub.add_parser("status", parents=[common], help="查看当前播放状态")
    s.set_defaults(func=cmd_status)

    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    # SUPPRESS 保证子解析器不覆盖主解析器的值，但缺省时属性可能不存在，这里补默认值
    if not hasattr(args, "device"):
        args.device = None
    if not hasattr(args, "timeout"):
        args.timeout = 3.0
    # cast 的 files 是 nargs="+"，但只取第一个
    if getattr(args, "_single", False) and len(args.files) > 1:
        args.files = args.files[:1]
        args.file = args.files[0]
    elif getattr(args, "_single", False):
        args.file = args.files[0]
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
