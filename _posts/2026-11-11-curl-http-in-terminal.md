---
title: '用 curl 摸清一次 HTTP 请求：从响应头到退出码'
date: 2026-11-11
course: 计算机网络
kind: 动手练习
tags: [curl, HTTP, 命令行, 网络排查]
summary: 六条命令把一次请求拆开看：GET 拿到什么、响应头怎么说、文件怎么落地、时间花在哪、POST 怎么发、失败时退出码是多少。
---

> 课程作业「任意使用 curl，截图记录，发布 blog」
> 环境：Windows 11 + Git Bash（MINGW64）· curl 8.22.0 · 目标是自己搭在 GitHub Pages 上的这个博客

## 结论先行

我把 curl 当成一台"HTTP 显微镜"，用它做了六件事，得到的结论是：

1. **curl 不判断业务对错，只判断传输对错。** 服务器返回 `500`，curl 依然认为"我成功拿到了这份 500"，退出码是 `0`；只有加上 `-f`，它才会把 4xx/5xx 当成失败，退出码变成 `22`。
2. **`-w` 里的 `time_*` 是累计时间，不是分段耗时。** 想得到"握手用了多久"，得自己相减。
3. **TLS 握手是这条链路上最贵的一步。** 我这台机器上，一次冷连接的 TLS 握手约 0.44 s，占了总耗时（0.78 s）的一半还多。
4. **`-o` 存下来的文件和服务器上的字节完全一致**（sha256 相同），所以 curl 顺手就能当下载器，还能当校验工具。
5. **curl 是可以写进脚本的**：`-s -f --retry --max-time` 加上退出码，就是一段足够稳的探活逻辑。

下面按顺序记录这六条命令，每条都附上真实输出。

## 一、先看看手里的是什么

```bash
curl --version | head -1
```

```text
curl 8.22.0 (Windows) libcurl/8.22.0 Schannel zlib/1.3.2 WinIDN WinLDAP
```

一行版本信息里其实藏着不少东西：`Schannel` 说明 TLS 用的是 Windows 自带实现（不是 OpenSSL），`zlib` 说明支持压缩，`WinIDN` 是国际化域名。

第一条请求，打给 `httpbin.org`——一个会把你发过去的东西原样回显的调试服务：

```bash
curl -s https://httpbin.org/get
```

```json
{
  "args": {},
  "headers": {
    "Accept": "*/*",
    "Host": "httpbin.org",
    "User-Agent": "curl/8.22.0"
  },
  "method": "GET",
  "origin": "48.46.108.6",
  "url": "https://httpbin.org/get"
}
```

![curl 版本与第一条 GET 请求]({{ '/assets/posts/curl/curl-01.png' | relative_url }})

这段回显就是一次 HTTP 请求的"体检报告"：

- `headers` 里只有三个头。curl 默认很克制：`Accept: */*`、`Host`、`User-Agent`，别的什么都不加。
- `origin` 是我的出口 IP；服务器看到的是 NAT 之后的地址，不是本机的 `192.168.x.x`。
- `-s` 关掉了进度条和错误提示。不加 `-s` 时，那条转圈的速度表会一起打到终端里，做脚本时反而是噪音。

## 二、看服务器怎么回答：响应头与存文件

`-I` 只发 HEAD，只要响应头，不要正文：

```bash
curl -sI https://ink-tx.github.io | head -12
```

```text
HTTP/1.1 200 OK
Connection: keep-alive
Content-Length: 8745
Server: GitHub.com
Content-Type: text/html; charset=utf-8
Last-Modified: Mon, 09 Nov 2026 12:58:42 GMT
Access-Control-Allow-Origin: *
Strict-Transport-Security: max-age=31556952
ETag: "6af1c382-2229"
expires: Wed, 11 Nov 2026 06:55:28 GMT
Cache-Control: max-age=600
x-proxy-cache: MISS
```

这十二行里，值得记下来的有四个：

| 头 | 值 | 说明了什么 |
|---|---|---|
| `Content-Length` | 8745 | 正文 8745 字节，和后面下载大小对得上 |
| `Server` | GitHub.com | 前面站着的是 GitHub 的 Pages 服务 |
| `x-proxy-cache` | MISS | 这一份是回源的，不是缓存命中 |
| `Cache-Control` | max-age=600 | 浏览器/CDN 可以缓存 10 分钟 |

`ETag` 是给缓存用的"内容指纹"：下次带 `If-None-Match` 来问，内容没变就只回 304，一个字节正文都不传。

接着把文件存到本地。`-O`（大写）表示"用 URL 里的文件名存盘"，`-o`（小写）可以自己起名字：

```bash
curl -sO https://ink-tx.github.io/assets/favicon.svg
ls -l favicon.svg
sha256sum favicon.svg
curl -sL https://ink-tx.github.io/assets/favicon.svg | sha256sum
```

```text
-rwxrwxrwx 1 wo2025 None      297 Nov 11 14:51 favicon.svg
7f25c6ebd076026709253ea634571b0c5c09676ff0b98480b70e90cd211ad0aa  favicon.svg
7f25c6ebd076026709253ea634571b0c5c09676ff0b98480b70e90cd211ad0aa  -
```

![响应头、存文件与 sha256 校验]({{ '/assets/posts/curl/curl-02.png' | relative_url }})

两个 sha256 一模一样，说明落盘的 297 字节和服务器上的 297 字节完全相同。这一步看着朴素，但它是"下载"和"下载对了"的区别：`curl -O` 成功只代表"字节都收到了"，校验才代表"收到的是对的那份"。

## 三、时间花在哪：`-w` 把一次请求拆成时间轴

`-w`（write-out）是 curl 里我最喜欢的一个参数。它能在请求结束后，按你给的模板再打印一行自己的东西：

```bash
curl -s -o /dev/null https://ink-tx.github.io \
  -w "DNS解析  %{time_namelookup}s\n\
TCP连接  %{time_connect}s\n\
TLS握手  %{time_appconnect}s\n\
首字节   %{time_starttransfer}s\n\
总耗时   %{time_total}s\n\
状态码   %{http_code}   大小 %{size_download}B\n"
```

```text
DNS解析  0.008802s
TCP连接  0.009822s
TLS握手  0.451695s
首字节   0.737651s
总耗时   0.775999s
状态码   200   大小 8745B
```

![用 -w 打印时间轴]({{ '/assets/posts/curl/curl-03.png' | relative_url }})

**这里有个容易看错的地方**：这些 `time_*` 全都是"从请求开始计时"的累计值，不是各阶段的耗时。真正的分段是相减得来的：

| 阶段 | 算法 | 本次耗时 |
|---|---|---|
| DNS 解析 | `time_namelookup` | 0.0088 s |
| TCP 连接 | `time_connect - time_namelookup` | 0.0010 s |
| TLS 握手 | `time_appconnect - time_connect` | 0.4419 s |
| 等待首字节 | `time_starttransfer - time_appconnect` | 0.2860 s |
| 内容传输 | `time_total - time_starttransfer` | 0.0383 s |

看出来的事情是：TCP 连接只花了 1 毫秒，**TLS 握手却花了 442 毫秒**——TCP 建连至少一次往返，TLS 握手再一到两次往返，在跨境线路上这个数字很典型。这也解释了为什么"复用连接"对性能影响那么大：后面的请求省掉的就是这 0.44 秒。

再跑三次，看看波动：

```bash
for i in 1 2 3; do
  curl -s -o /dev/null -w "第 $i 次  %{time_total}s\n" https://ink-tx.github.io
done
```

```text
第 1 次  0.860911s
第 2 次  0.697007s
第 3 次  0.783083s
```

同样的目标、相隔不到一秒，总耗时在 0.70–0.86 s 之间跳。所以单次测量说明不了太多问题，要看趋势就得取多次的中位数——这也是后面写探活脚本时该设"超时阈值"而不是"精确耗时"的原因。

## 四、把话递过去：POST 一段 JSON

`-X POST` 换方法，`-H` 加请求头，`-d` 带请求体：

```bash
curl -s -X POST https://httpbin.org/post \
  -H "Content-Type: application/json" \
  -d '{"name":"ink-tx","task":"curl-homework","score":100}' | python -m json.tool
```

```json
{
    "args": {},
    "headers": {
        "Accept": "*/*",
        "Content-Length": "52",
        "Content-Type": "application/json",
        "Host": "httpbin.org",
        "User-Agent": "curl/8.22.0"
    },
    "method": "POST",
    "origin": "48.46.108.6",
    "url": "https://httpbin.org/post",
    "data": "{\"name\":\"ink-tx\",\"task\":\"curl-homework\",\"score\":100}",
    "files": {},
    "form": {},
    "json": {
        "name": "ink-tx",
        "score": 100,
        "task": "curl-homework"
    }
}
```

![发送 POST JSON]({{ '/assets/posts/curl/curl-04.png' | relative_url }})

几个细节：

- **`-d` 会自动把方法变成 POST**，所以这里的 `-X POST` 其实是多余的；写出来是为了让命令自解释。如果只想换方法、不带 body（比如 `-X DELETE`），那才必须写 `-X`。
- `-d` 的默认 `Content-Type` 是 `application/x-www-form-urlencoded`。发 JSON 一定要自己加 `-H "Content-Type: application/json"`，否则服务端会按表单去解析，然后一脸茫然。
- `Content-Length: 52` 是 curl 自己算的——那串 JSON 正好 52 字节。
- 管道末尾用 `python -m json.tool` 把一行压扁的 JSON 重新缩进。Windows 上没装 `jq`，这是最省事的替代。

## 五、最容易被忽略的一课：退出码

这是这次练习里我收获最大的一段。先请求一个必定返回 500 的地址：

```bash
curl -s -o /dev/null \
  -w "HTTP %{http_code}, exit=%{exitcode}\n" https://httpbin.org/status/500
```

```text
HTTP 500, exit=0
```

**HTTP 状态码是 500，curl 的退出码却是 0。** 换成脚本的视角，这意味着"成功"。因为 curl 的职责到"把响应完整收下来"为止，至于这份响应是 200 还是 500，它不管。

想让 4xx/5xx 也变成失败，加 `-f`（`--fail`）：

```bash
curl -s -f -o /dev/null \
  -w "HTTP %{http_code}, exit=%{exitcode}\n" https://httpbin.org/status/500
```

```text
HTTP 500, exit=22
```

![退出码与 -f]({{ '/assets/posts/curl/curl-05.png' | relative_url }})

退出码 `22` 是 `CURLE_HTTP_RETURNED_ERROR`。常用的几个：

| 退出码 | 含义 | 常见原因 |
|---|---|---|
| `0` | 成功 | 传输完成，不管 HTTP 状态码是多少 |
| `6` | 无法解析主机 | DNS 挂了、域名拼错 |
| `7` | 连接失败 | 端口没开、被防火墙拦 |
| `22` | HTTP 错误（仅 `-f`） | 4xx / 5xx |
| `28` | 超时 | 触发了 `--max-time` / `--connect-timeout` |
| `35` | TLS 握手失败 | 协议/加密套件不匹配 |
| `60` | 证书校验失败 | 自签证书、证书过期 |

## 六、把它写进脚本

把这几个参数拼起来，就是一段可以放进 `cron` 的探活逻辑：

```bash
if curl -sS -f --retry 3 --retry-delay 2 \
        --connect-timeout 5 --max-time 15 \
        -o /dev/null -w '%{http_code}\n' https://ink-tx.github.io; then
  echo "博客正常"
else
  echo "博客异常，退出码 $?"
fi
```

每个参数都在补一个坑：

- `-s` 静音、`-S` 把错误信息还回来——两个一起用，成功时安静，失败时说话。
- `-f` 让 4xx/5xx 走失败分支，否则 500 会被当成"正常"。
- `--retry 3` 对网络抖动重试；注意默认**只重试"传输层错误"**，想连 5xx 一起重试要加 `--retry-all-errors`。
- `--max-time` 是整次请求的上限，`--connect-timeout` 只管连接阶段。不设上限的话，一个卡住的连接能把脚本挂到天亮。

## 七、彩蛋：用 curl 查自己的博客

最后一个请求，不打别人，打自己的仓库：

```bash
curl -s "https://api.github.com/repos/ink-tx/ink-tx.github.io" \
  | grep -E '"(description|pushed_at|default_branch)"'
```

```text
  "description": "我的个人博客",
  "pushed_at": "2026-11-09T12:58:03Z",
  "default_branch": "main",
```

```bash
curl -sI https://ink-tx.github.io | head -1
```

```text
HTTP/1.1 200 OK
```

![用 curl 查自己的博客]({{ '/assets/posts/curl/curl-06.png' | relative_url }})

`pushed_at` 和站点返回的 `200` 放在一起看，就是一条完整的链路：代码推到 GitHub，Pages 构建，站点可达。这篇文章本身也会成为下一个 `pushed_at`。

## 八、常用参数速查

| 参数 | 作用 | 备注 |
|---|---|---|
| `-s` / `-S` | 静音 / 恢复错误输出 | 脚本里几乎总是成对出现 |
| `-o FILE` / `-O` | 存到指定文件 / 用 URL 里的名字 | 失败时不写文件要加 `--remove-on-error` |
| `-I` | 只取响应头（HEAD） | 有些服务不支持 HEAD，会返回 405 |
| `-L` | 跟随重定向 | 默认不跟随，`3xx` 会原样返回 |
| `-f` | 4xx/5xx 视为失败 | 退出码 22 |
| `-w FORMAT` | 自定义输出 | 变量见 `curl --help all` 或手册 |
| `-d` / `--data-binary` | 请求体 | `-d` 会吃掉换行，二进制/文件用后者 |
| `-H` | 加请求头 | 可重复；`-H "Host:"` 这种"空值"写法可移除 curl 默认加的头 |
| `--retry N` | 传输失败重试 | 加 `--retry-all-errors` 才重试 5xx |
| `-v` | 打印完整往返 | 调试必用，能看到 `>` 请求和 `<` 响应 |

## 九、踩到的坑

1. **Windows 上的引号**。Git Bash 里发 JSON 用单引号 `-d '{"a":1}'`；换到 `cmd` 或 PowerShell，单引号不是字符串定界符，`-d "{\"a\":1}"` 又要转义成 `""`，非常难受。这也解释了为什么很多 Windows 上的 curl 教程干脆让你把 JSON 写进文件：`-d @body.json`。
2. **`-o /dev/null` 在 Git Bash 里能用**，但 `NUL` 才是 Windows 原生的空设备。写跨平台的脚本时，`-o /dev/null` 依赖运行在 MSYS 环境里。
3. **`httpbin.org` 会抽风**。练习时遇到过几次 502，重试就恢复。这也让"重试"这件事变得必要，而不只是理论。
4. **`-I` 与 `-X HEAD` 不是一回事**。`-I` 是"发 HEAD"，`-X HEAD` 只是把方法字符串换掉、却仍然等正文，很容易卡住直到超时。
5. **`-L` 会让计时变得难读。** 加 `-L` 之后 `time_total` 覆盖的是整条重定向链，而不是最后一次请求；想分开看每一跳，就单跑一次，或者加 `-v` 去看每次回应的 `Location`。

## 关于这几张截图

作业要求"截图记录"。这里的做法是：所有命令都由一个脚本逐条**真实执行**，输出原样写进 `raw/shot*.txt`，再用一个几十行的 Pillow 脚本把这些贴纸渲染成终端窗口的样子。也就是说，**截图里的每一个字都是命令的真实输出，命令本身也一字未改**；只有窗口边框、字体和配色是画上去的。

这么做不是为了好看，是因为我想让"截图"这件事本身也可核对：把渲染脚本和原始输出一起留着，任何人重跑一遍都能拿到同样的结果。

## 小结

curl 只有两个动词：**让它说**，和**让它做**。`-I`、`-w`、`-v` 是让它说——把服务器怎么回答、每一段花了多久、往返里到底有什么，全摊开给你看；`-d`、`-H`、`-o` 是让它做——把请求发出去、把文件收下来。

而真正决定它能不能进脚本的，是那个最不起眼的退出码：**HTTP 500 不等于失败，除非你说了 `-f`。**

---

*本文使用的命令脚本与原始输出都在本地 `curl-hw/` 目录中，截图由 `render.py` 从真实输出渲染得到。*
