# 博客项目说明（给 AI 的上下文备忘）

> 开新窗口时，先让我读这个文件，就不用重新克隆/摸索整个仓库了。

## 仓库与站点
- 仓库：`panghehe666/panghehe666.github.io`（GitHub Pages，Jekyll + Hux Blog 主题）
- 线上：https://panghehe666.github.io
- 默认分支：`master`

## 目录速览
- `_posts/`：文章，文件名 `YYYY-MM-DD-slug.md` / `.markdown`
- `_layouts/`、`_includes/`：主题模板（页脚、导航、文章布局等）
- `css/`、`js/`：主题资源
- `_config.yml`：站点配置（标题、SEO、分页、排除项）
- 特殊页面：`calendar.html`（日历/贡献图）、`models.html`（可视化模型实验室）、`admin.html`（私密文章管理）
- 本文件 `BLOG.md` 已加入 `_config.yml` 的 exclude，不会被发布成页面

## 文章 front matter 模板
```yaml
---
layout:       post
title:        "标题"
author:       "PHH"
header-style: text
catalog:      true
tags:
    - 开源分享
    - 前沿科技
---
```
正文 markdown；作者统一 `PHH`；私密文章另加 `private_cipher` 字段，用 `/admin/` 登录解密。

## 发布方式（比 git clone 快）
- 用 GitHub Contents API 直接提交：
  `PUT /repos/panghehe666/panghehe666.github.io/contents/<path>`
- Token 在 `~/.dsh_gh_token`（fine-grained PAT，权限：Contents Read and write）
- 提交后 Pages 约 30–60 秒重建；用 curl 轮询目标 URL 直到 200 确认上线
- 大批量增删（如清理文章）可用 git data API 一次性原子提交

## 写作约定
- 中文、口语化、第一人称；标题常用「冒号」结构
- 不虚构链接与数据；引用外部内容时文末注明来源

## 已知状态（会过时，动手前建议先核对）
- 文章作者统一 PHH；主题演示文章和根目录 Hux 残留已清理
- 日历页年份下拉范围：过去 10 年 ~ 未来 5 年
- 文章底部分页：Next 在右（指向较旧），Previous 在左（指向较新）
