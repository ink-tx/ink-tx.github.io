# 墨水日志 · ink-tx 的作业博客

网站：https://ink-tx.github.io/

用来发布课程作业、实验报告与学习记录。GitHub Pages 自动把 Markdown 生成网页，支持课程分类、归档、搜索、文章目录、代码复制、深色模式和打印 PDF。首页仅统计已发布的真实作业。

## 发布下一篇作业

1. 打开网站的「写作业」，填写标题、课程和正文。草稿只保存在当前浏览器，还不会公开。
2. 点击「在 GitHub 发布」，用具有仓库写入权限的账号检查文件，点击 **Commit changes**。长文会提供 Markdown 下载，请将文件上传到 `_posts/`。
3. 等待 GitHub Pages 部署完成，在首页打开新作业，点击「复制作业链接」，提交给老师。

也可以直接在 GitHub 的 `_posts/` 文件夹新增 `YYYY-MM-DD-英文标识.md`，参考 [`templates/assignment.md`](templates/assignment.md)：

```yaml
---
title: "QQ 流量分析实验报告"
date: 2026-11-09
course: "计算机网络"
kind: "实验报告"
tags: ["Wireshark", "TCP", "UDP"]
summary: "一句话介绍这份作业的目标和发现。"
---
```

在上面的信息下方写 Markdown 正文。正文从 `##` 二级标题开始，页面会自动展示标题并生成目录。相同 `course` 的作业会归为同一课程，`kind` 可填「实验报告」「读书报告」等。

- 文件名中的英文标识应当唯一，发布后尽量保持不变，以免影响已提交的链接。
- 日期采用 `Asia/Taipei` 时区，未来日期的作业不会显示；到指定日期需重新提交更改触发构建。
- 截图上传到 `assets/images/`，在正文用 `![图片说明](/assets/images/example.png)` 引用。
- 作业的网页链接为 `/assignments/英文标识/`。日期和课程不影响该链接。

原仓库的 `blog.md` 保留原样，其内容已接入 `_posts/2026-10-19-qq-traffic-analysis.md`。该日期采用原文件上传的提交日期。

## 网站维护

- `_config.yml`：站名、作者、简介。
- `_layouts/`、`_includes/`：页面模板。
- `assets/style.css`：界面、响应式布局和打印样式。
- `assets/app.js`：搜索、目录、复制、草稿和 Markdown 导出。

GitHub 仓库 **Settings → Pages** 保持 **Deploy from a branch → main → /(root)**，无需配置其他部署服务或密钥。Jekyll 及其插件由 GitHub Pages 提供。

可选本地预览（需 Ruby / Bundler）：

```sh
bundle install
bundle exec jekyll serve
```

打开 `http://127.0.0.1:4000/`。
