#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
通用 HTTP 文件服务，带 Range 支持与 DLNA 响应头。

为什么需要它
    DLNA 播放器（电视 / 投影 / 机顶盒 / 播放器盒）拉流时会发 Range 请求，
    用来秒开和拖动进度条。Python 自带的 http.server 不支持 Range，一律返回
    200 + 整个文件，结果是：进度条拖不动，大文件还可能中途断流。
    这个脚本补上 RFC 7233 的 Range 语义（206 + Content-Range），并附带
    DLNA 的 transferMode / contentFeatures 头，让设备愿意直接流式播放。

命令行用法
    python3 range_server.py                              # 服务当前目录，端口 8899
    python3 range_server.py --root ~/Movies --port 9000
    python3 range_server.py --root ~/Movies --list-dirs  # 允许浏览器浏览目录

作为模块用法
    from range_server import serve_in_thread
    httpd, port, thread = serve_in_thread("~/Movies")
"""

import argparse
import http.server
import os
import re
import shutil
import socketserver
import sys
import threading

DEFAULT_PORT = 8899

# DLNA 头：OP=01 表示同时支持 byte-range seek；CI=0 表示不转码；
# FLAGS 里的 01700000... 是 DLNA 常见的 "streaming + background transfer" 组合。
DLNA_CONTENT_FEATURES = (
    "DLNA.ORG_OP=01;DLNA.ORG_CI=0;"
    "DLNA.ORG_FLAGS=01700000000000000000000000000000"
)


class _BoundedReader:
    """只允许读出指定字节数，防止 SimpleHTTPRequestHandler 读越界。"""

    def __init__(self, fileobj, limit):
        self._f = fileobj
        self._left = limit

    def read(self, size=-1):
        if size is None or size < 0:
            size = self._left
        size = min(size, self._left)
        if size <= 0:
            return b""
        data = self._f.read(size)
        self._left -= len(data)
        return data

    def close(self):
        try:
            self._f.close()
        except Exception:
            pass


def make_handler(root, list_dirs=False, quiet=False):
    """生成一个绑定到指定根目录的请求处理器类。"""

    root = os.path.abspath(os.path.expanduser(root))

    class RangeHandler(http.server.SimpleHTTPRequestHandler):
        server_version = "range_server/1.0"
        protocol_version = "HTTP/1.1"

        def __init__(self, *a, **kw):
            super().__init__(*a, directory=root, **kw)

        # ---- 日志 ----
        def log_message(self, fmt, *args):
            if not quiet:
                sys.stderr.write(
                    "[%s] %s - %s\n" % (self.log_date_time_string(), self.address_string(), fmt % args)
                )
            sys.stderr.flush()

        def log_error(self, fmt, *args):
            if not quiet:
                super().log_error(fmt, *args)

        # ---- 核心：带 Range 的响应 ----
        def send_head(self):
            path = self.translate_path(self.path)

            if os.path.isdir(path):
                if not list_dirs:
                    self.send_error(403, "Directory listing disabled")
                    return None
                return super().send_head()

            if not os.path.isfile(path):
                self.send_error(404, "File not found")
                return None

            try:
                size = os.path.getsize(path)
                mtime = os.path.getmtime(path)
            except OSError:
                self.send_error(404, "File not found")
                return None

            ctype = self.guess_type(path)
            first, last, partial = 0, size - 1, False
            range_header = self.headers.get("Range")

            if range_header:
                m = re.match(r"bytes\s*=\s*(\d*)\s*-\s*(\d*)", range_header.strip())
                if m and (m.group(1) or m.group(2)):
                    if m.group(1):
                        first = int(m.group(1))
                        if m.group(2):
                            last = min(int(m.group(2)), size - 1)
                    else:
                        # bytes=-N 表示最后 N 字节
                        n = int(m.group(2))
                        first = max(size - n, 0)
                        last = size - 1

                    if first >= size:
                        self.send_response(416)
                        self.send_header("Content-Range", "bytes */%d" % size)
                        self.send_header("Content-Length", "0")
                        self.end_headers()
                        return None
                    if first > last:
                        self.send_error(416, "Range Not Satisfiable")
                        return None
                    partial = True

            if size == 0:
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", "0")
                self.send_header("Accept-Ranges", "bytes")
                self.end_headers()
                return None

            length = last - first + 1
            f = open(path, "rb")
            f.seek(first)

            self.send_response(206 if partial else 200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(length))
            self.send_header("Accept-Ranges", "bytes")
            if partial:
                self.send_header("Content-Range", "bytes %d-%d/%d" % (first, last, size))
            self.send_header("Last-Modified", self.date_time_string(mtime))
            self.send_header(
                "Content-Disposition",
                'inline; filename="%s"' % os.path.basename(path).replace('"', ""),
            )
            # DLNA 头：告诉设备这是可直接流式播放、支持 seek 的静态资源
            self.send_header("transferMode.dlna.org", "Streaming")
            self.send_header("contentFeatures.dlna.org", DLNA_CONTENT_FEATURES)
            self.end_headers()
            return _BoundedReader(f, length)

        def copyfile(self, source, outputfile):
            # 播放器拖动进度条时会主动断开旧连接，这不是错误
            try:
                shutil.copyfileobj(source, outputfile)
            except (BrokenPipeError, ConnectionResetError):
                pass

    return RangeHandler


class ThreadingHTTPServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True
    # HTTP/1.1 keep-alive：设备连续拉多个分片时减少握手开销
    request_queue_size = 32


def serve_in_thread(root, port=DEFAULT_PORT, bind="0.0.0.0", list_dirs=False, quiet=True):
    """在后台线程启动服务。返回 (httpd, 实际端口, thread)。

    port 传 0 或端口被占用时，自动改用系统分配的空闲端口。
    """
    handler = make_handler(root, list_dirs=list_dirs, quiet=quiet)
    try:
        httpd = ThreadingHTTPServer((bind, port), handler)
    except OSError:
        if port == 0:
            raise
        httpd = ThreadingHTTPServer((bind, 0), handler)  # 端口被占用就换一个
    actual_port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, name="range-server", daemon=True)
    thread.start()
    return httpd, actual_port, thread


def main(argv=None):
    p = argparse.ArgumentParser(
        description="带 Range 支持的 HTTP 文件服务（DLNA 投屏/拖动进度条必需）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="示例：\n"
               "  python3 range_server.py --root ~/Movies\n"
               "  python3 range_server.py --root ~/Movies --port 9000 --list-dirs\n",
    )
    p.add_argument("--root", "-r", default=".", help="要服务的目录（默认当前目录）")
    p.add_argument("--port", "-p", type=int, default=DEFAULT_PORT, help="监听端口（默认 %d）" % DEFAULT_PORT)
    p.add_argument("--bind", default="0.0.0.0", help="监听地址（默认 0.0.0.0，局域网可访问）")
    p.add_argument("--list-dirs", action="store_true", help="允许浏览目录（默认关闭）")
    p.add_argument("--quiet", "-q", action="store_true", help="不打印访问日志")
    args = p.parse_args(argv)

    root = os.path.abspath(os.path.expanduser(args.root))
    if not os.path.isdir(root):
        print("目录不存在：%s" % root, file=sys.stderr)
        return 2

    handler = make_handler(root, list_dirs=args.list_dirs, quiet=args.quiet)
    httpd = ThreadingHTTPServer((args.bind, args.port), handler)
    print("服务目录：%s" % root)
    print("监听：http://%s:%d/  （Ctrl-C 退出）" % (args.bind, httpd.server_address[1]))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
