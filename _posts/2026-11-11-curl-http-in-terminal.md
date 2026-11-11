---
title: '用 curl 拆开一次 HTTP 请求'
date: 2026-11-11
course: 计算机网络
kind: 动手练习
tags: [curl, HTTP, 命令行, 网络排查]
summary: 六条命令，从响应头到退出码。顺带发现一件事：服务器回 500 的时候，curl 觉得一切正常。
---

> 课程作业：任意使用 curl，截图记录，发布 blog。
> 环境：Windows 11 + Git Bash，curl 8.22.0，折腾对象是我自己搭在 GitHub Pages 上的这个博客。

老师说"随便用 curl 做点什么"的时候，我愣了一下。

curl 我天天见。装依赖、拉镜像、测接口，哪天不用它十次。可要是有人问我"它到底替你做了什么"，我大概率只能答上来一句：跑完命令，屏幕上会出来一堆东西。

至于那堆东西是什么、从哪来、为什么长这样，我平时一概不看。看一眼结果，能用就行。

所以这次我给自己换了个目标：不看结果，看过程。一条一条问下去——它到底发出去了什么，服务器怎么回的，时间花在哪，出错的时候它又是怎么告诉我的。

下面就是这六条命令，和我从里面翻出来的东西。

## 先看看手里这玩意儿的家底

```bash
curl --version | head -1
```

```text
curl 8.22.0 (Windows) libcurl/8.22.0 Schannel zlib/1.3.2 WinIDN WinLDAP
```

以前这行我一直当废话划过去。这次逐个数了一遍，才发现它把家底都报了：`Schannel` 说明 TLS 用的是 Windows 自带的实现，不是 OpenSSL；`zlib` 说明它能解压；`WinIDN` 是国际化域名。

然后是第一发。目标选了 `httpbin.org`——你发什么，它就原样回显什么，拿来照镜子正合适。

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

回显里有个细节我盯了一会儿：`headers` 里只有三个头。

`Accept: */*`、`Host`、`User-Agent`，没别的了。跟浏览器一比就知道这有多"朴素"——浏览器发请求，恨不得先递上一份简历，身份、能力、偏好、上次来过没，全写上。curl 不，它就三个头，问什么答什么。

另外两点：

`origin` 是我的出口 IP。服务器看到的永远是这个，不是我本机的 `192.168.x.x`——中间隔着一层 NAT，它是真不知道我是谁。

`-s` 关掉的是进度条和报错。不加它的时候，那根转圈的速度表会一起打到终端里。人看还行，写脚本就是纯噪音。

## 服务器怎么回话

想听服务器自己说，用 `-I`，只发 HEAD，只要头，不要正文：

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

十二行里，有四行值得多看两眼：

| 头 | 值 | 它在说什么 |
|---|---|---|
| `Content-Length` | 8745 | 正文 8745 字节，跟后面下载的大小对得上 |
| `Server` | GitHub.com | 前面站的是 GitHub 的 Pages |
| `x-proxy-cache` | MISS | 这一份是回源的，没吃到缓存 |
| `Cache-Control` | max-age=600 | 浏览器和 CDN 可以缓存 10 分钟 |

`ETag` 是给缓存用的指纹。下次带着 `If-None-Match` 来问，内容没变就只回一个 304，正文一个字节都不传——我第一次看懂这个的时候，觉得挺妙的：省流量靠的不是压得更狠，是干脆不发。

接着把文件存下来。`-O` 是大写那个，意思是"用 URL 里的名字存"；小写的 `-o` 可以自己起名字。

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

两个 sha256 一模一样。

这一步看着朴素，但它区分的是两件事：**"下载了"和"下载对了"**。`curl -O` 不报错，只说明字节都收到了；至于收到的是不是那份，得校验了才知道。以后从随便什么源上拉二进制，我都会补这一下。

## 时间都花在哪了

`-w` 是 curl 里我最喜欢的一个参数——请求跑完，它按你给的模板再打印一行自己的东西：

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

这里有个坑，我第一眼看错了：这些 `time_*` **全是"从请求开始计时"的累计值**，不是各阶段各自的耗时。直接读会得到"TCP 连接花了 9.8 毫秒"这种结论——假的，那 9.8 毫秒里有 8.8 毫秒是在等 DNS。

得相减：

| 阶段 | 算法 | 这次 |
|---|---|---|
| DNS 解析 | `time_namelookup` | 0.0088 s |
| TCP 连接 | `time_connect - time_namelookup` | 0.0010 s |
| TLS 握手 | `time_appconnect - time_connect` | 0.4419 s |
| 等待首字节 | `time_starttransfer - time_appconnect` | 0.2860 s |
| 内容传输 | `time_total - time_starttransfer` | 0.0383 s |

减完，故事就清楚了：TCP 建连只花 1 毫秒，**TLS 握手却吃掉了 442 毫秒**，比剩下所有环节加起来还多。一条跨境链路，TCP 一次往返、TLS 再一到两次往返，这就是那 0.44 秒的来源。

也难怪 HTTP 长连接这么要紧——省掉的正是这 0.44 秒。

我又连着跑了三次，看它稳不稳：

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

同样的目标，相隔不到一秒，0.70 到 0.86 之间跳。所以单次测速说明不了什么——想判断"快慢"，得多取几次看中位数。写探活脚本的时候也是这个道理：超时阈值要设得宽容点，别拿某一次的漂亮数字当标准。

## 把话递过去

`-X` 换方法，`-H` 加头，`-d` 带请求体：

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

几个我后来才弄明白的细节：

**`-d` 自己就会把方法改成 POST**，所以前面那个 `-X POST` 其实是多余的，写出来只是让命令自己解释自己。真正需要 `-X` 的场合是不带 body、只换方法，比如 `-X DELETE`。

**`-d` 的默认 `Content-Type` 是表单**，不是 JSON。不自己加那个头，服务端会按表单去解析，然后一脸茫然地回你一堆错。我在这上面浪费过时间。

`Content-Length: 52` 是 curl 自己算的，那串 JSON 正好 52 字节。

`| python -m json.tool` 是把压成一行的 JSON 重新缩进。这台机器没有 `jq`，它是最省事的替代品。

## 我踩到的那个坑：500 不算失败

接下来这段是这次最大的收获，也是最反直觉的一段。

请求一个必定返回 500 的地址：

```bash
curl -s -o /dev/null \
  -w "HTTP %{http_code}, exit=%{exitcode}\n" https://httpbin.org/status/500
```

```text
HTTP 500, exit=0
```

我盯着这个 `exit=0` 看了两遍。

**HTTP 状态码 500，curl 的退出码却是 0。** 换成脚本的视角，这意味着"成功"。

想了半天，这个设计其实是自洽的：curl 的职责到"把响应完整收下来"为止，至于这份响应是 200 还是 500，那是业务的事，不归它管。它只保证一件事——我给你送到了，而且是完整送到的。

想让 4xx/5xx 也算失败，得自己说一声，加 `-f`：

```bash
curl -s -f -o /dev/null \
  -w "HTTP %{http_code}, exit=%{exitcode}\n" https://httpbin.org/status/500
```

```text
HTTP 500, exit=22
```

![退出码与 -f]({{ '/assets/posts/curl/curl-05.png' | relative_url }})

`22` 是 `CURLE_HTTP_RETURNED_ERROR`。顺手把常见的几个也记下来：

| 退出码 | 含义 | 一般是什么情况 |
|---|---|---|
| `0` | 成功 | 传输完成，不管 HTTP 状态码多少 |
| `6` | 无法解析主机 | DNS 挂了，或者域名拼错 |
| `7` | 连接失败 | 端口没开，被防火墙拦了 |
| `22` | HTTP 错误（仅 `-f`） | 4xx / 5xx |
| `28` | 超时 | 撞上 `--max-time` / `--connect-timeout` |
| `35` | TLS 握手失败 | 协议或加密套件对不上 |
| `60` | 证书校验失败 | 自签证书、证书过期 |

一个 500 页面，在浏览器里是"这站挂了"，在 curl 里是"零"，在加了 `-f` 的 curl 里是"22"。同一件事，三种说法。

## 那就把它写进脚本

把这几个参数摞起来，就是一段能塞进 `cron` 的探活：

```bash
if curl -sS -f --retry 3 --retry-delay 2 \
        --connect-timeout 5 --max-time 15 \
        -o /dev/null -w '%{http_code}\n' https://ink-tx.github.io; then
  echo "博客正常"
else
  echo "博客异常，退出码 $?"
fi
```

每个参数都在补一个具体的坑：

`-s` 静音，`-S` 把报错还回来。两个一起用，成功的时候一句话不说，失败的时候才吭声。

`-f` 让 4xx/5xx 走失败分支，否则前面那个坑会原封不动地搬进脚本里。

`--retry 3` 重试网络抖动。但要注意它默认**只重试传输层错误**，想连 5xx 一起重试，得再补一个 `--retry-all-errors`。

`--max-time` 是整次请求的上限，`--connect-timeout` 只管连接那一段。不设上限，一个卡住的连接能把脚本挂到第二天。

## 彩蛋：用 curl 查自己的博客

最后这条不打别人，打自己的仓库：

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

`pushed_at` 和那个 `200` 放在一起看，就是一条完整的链路：代码推上去，Pages 构建，站点可达。

这篇文章本身，等下也会变成下一个 `pushed_at`。

## 顺手留一张速查表

| 参数 | 作用 | 备注 |
|---|---|---|
| `-s` / `-S` | 静音 / 把错误还回来 | 脚本里几乎总是成对出现 |
| `-o FILE` / `-O` | 存到指定文件 / 用 URL 里的名字 | 失败时不想留半截文件，加 `--remove-on-error` |
| `-I` | 只要响应头（HEAD） | 有些服务不支持 HEAD，会回 405 |
| `-L` | 跟随重定向 | 默认不跟，`3xx` 原样返回 |
| `-f` | 4xx/5xx 视为失败 | 退出码 22 |
| `-w FORMAT` | 自定义输出 | 变量很多，查手册比背强 |
| `-d` / `--data-binary` | 请求体 | `-d` 会吃掉换行，二进制和文件用后者 |
| `-H` | 加请求头 | 可重复；`-H "Host:"` 这种空值写法能移除默认头 |
| `--retry N` | 传输失败重试 | 加 `--retry-all-errors` 才管 5xx |
| `-v` | 打印完整往返 | 调不动的时候第一个想起来的就是它 |

## 几个不太舒服的地方

**Windows 上的引号。** Git Bash 里发 JSON 用单引号就完事：`-d '{"a":1}'`。换到 `cmd` 或者 PowerShell，单引号不是字符串定界符，得写成 `-d "{\"a\":1}"`，再换个 shell 又不一样。所以很多 Windows 教程干脆教你写文件：`-d @body.json`。不是他们偷懒，是引号真的能耗掉一晚上。

**`-o /dev/null` 在 Git Bash 里能用**，但 Windows 原生认的是 `NUL`。写跨平台脚本的时候，这一行会悄悄变成坑。

**`httpbin.org` 会抽风。** 练习中间我撞上过几次 502，重试就恢复。也正因为撞上了，后面那段"重试"才不像纸上谈兵。

**`-I` 和 `-X HEAD` 不是一回事。** `-I` 是规规矩矩发 HEAD；`-X HEAD` 只是把方法字符串换掉，程序还在傻等正文，很容易一直卡到超时。

**`-L` 会让计时变得难读。** 加了它，`time_total` 覆盖的是整条重定向链，不再是最后一次请求。想分开看每一跳，就单跑一次，或者加 `-v` 盯 `Location`。

## 写在最后

curl 好像只有两个动词：**让它说**，和**让它做**。

`-I`、`-w`、`-v` 是让它说——服务器怎么回的、每一段花了多久、来回的路上到底有什么，全摊开给你看。`-d`、`-H`、`-o` 是让它做——把话发出去，把文件收下来。

而真正决定它能不能进脚本、能不能替你守夜的，是那个最不起眼的退出码。

**HTTP 500 不等于失败，除非你说了 `-f`。**

这句话我大概会记很久。不是因为它难，是因为它太容易想当然了。
