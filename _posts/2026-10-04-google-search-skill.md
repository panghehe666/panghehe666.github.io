---
layout:       post
title:        "Google 搜索技巧"
author:       "PHH"
header-style: text
catalog:      true
tags:
    - 开源分享
---

* TOC
{:toc}

> 众所周知，Google 是一种好用的搜索引擎。用好它不仅需要魔法，还需要一点搜索技巧。

四个运算符就够日常用：指定站点、精确匹配、限定文件类型、通配符补全。下面每条都配一张实机截图。

## 1. `site:` 指定网站

搜索范围会被锁在某个站点里，不会满世界乱跑。

**写法：**

```
关键词 site:域名
```

**例子：** `termux site:github.com`

结果只会来自 GitHub。想找官方仓库、Issue、命令备忘录时特别好用。

![](https://cdn.jsdelivr.net/gh/panghehe666/panghehe666.github.io@master/img/in-post/google-search-skill/site-github.jpg)
*搜索 `termux site:github.com`：结果全是 GitHub 上的 Termux 相关页面*

小提示：域名写成 `github.com`，中间不要空格。写成 `github com` 就失效了。

## 2. `"精确短语"` 一字不差

把关键词用英文双引号包起来，Google 会按整句匹配，而不是拆开每个字分别搜。

**写法：**

```
"你的问题"
```

适合找书名、报错原文、某一句固定说法。不加引号时，页面里只要零散出现这些字也可能被搜出来。

![](https://cdn.jsdelivr.net/gh/panghehe666/panghehe666.github.io@master/img/in-post/google-search-skill/exact-phrase.jpg)
*搜索 `"你的问题"`：命中的是书名里完整出现这四个字的结果*

## 3. `filetype:` 只要某类文件

只看 PDF、PPT、DOC 这类文档时，加上文件类型即可。

**写法：**

```
关键词 filetype:pdf
```

**例子：** `python filetype:pdf`

结果会带 PDF 标记，教程、讲义、官方文档都能直接下。

![](https://cdn.jsdelivr.net/gh/panghehe666/panghehe666.github.io@master/img/in-post/google-search-skill/filetype-pdf.jpg)
*搜索 `python filetype:pdf`：第一条就是 Python Tutorial 的 PDF*

常用后缀还有 `ppt`、`doc`、`xls`、`txt`。

## 4. `*` 通配符：忘了中间那个词

不确定中间缺哪个词，或者想一次覆盖多种说法，用 `*` 占位。Google 会拿相关词填进去。

**写法：**

```
the * of money
```

可能出现 *the psychology of money*、*the use of money*、*the role of money* 等等。

![](https://cdn.jsdelivr.net/gh/panghehe666/panghehe666.github.io@master/img/in-post/google-search-skill/wildcard.jpg)
*搜索 `the * of money`：第一条就是 The Psychology of Money*

记不清书名、歌词或固定搭配时，这个最省事。

---

## 速查

| 技巧 | 写法 | 作用 |
| --- | --- | --- |
| 指定站点 | `termux site:github.com` | 只在某个网站里搜 |
| 精确匹配 | `"你的问题"` | 按完整短语搜 |
| 文件类型 | `python filetype:pdf` | 只要 PDF 等文档 |
| 通配符 | `the * of money` | 让 Google 补上中间的词 |

四个一起用也没问题，例如：

```
"python tutorial" filetype:pdf site:docs.python.org
```

## 总结

会这四招，搜东西会准很多：指定场地、锁死原句、只要文档、漏词用星号顶上。去搜索框里试一遍，比看教程记得更牢。
