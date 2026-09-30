---
layout:     post
title:      "markdowm语法技巧"
subtitle:   "信息、载体、抽象、UI 设计乱谈"
date:       2026-9-27
author:     "庞和合"
header-img: "img/post-bg-os-metro.jpg"
catalog: true
tags:
  - hUX 随想录
  - UX/UI 
---
# markdown常用语法技巧
* TOC
{:toc}

# 1.强调
```markdown
*斜体* 或 _斜体_
**粗体** 或 __粗体__
***粗斜体*** 或 ___粗斜体___
~~删除线~~
==高亮== (部分扩展支持)
```
---
# 2.代码块
行内代码

```markdown
使用 `printf()` 函数
```

代码块


行内代码

```markdown
`代码内容` 
```

代码块

<pre>
```语言名称
// 代码内容
function hello() {
  console.log("Hello Markdown!");
}
```
</pre>

常用语言标识：javascript, python, html, css, bash, json, markdown
___
# 3.目录
```markdown
## 目录
- [章节一](#章节一)
  -[章节1.1](##章节1.1)
- [章节二](#章节二)

```
备注：`()`==不加空格==
___
# 4.引用
```markdown
> 一级引用
> > 嵌套引用
> 
> 引用内可以包含其他Markdown元素
> - 列表
> - 等
```

example:
> 我好帅 --庞和合

---
# 5.分割线
```markdown
---
```
---
# 6.表格
```markdown
| 姓名| 派别 | 性别 |
| :--- | :---: | ---: |
| 古月方源| 魔道 | 男 |
| 古月娜 | 斗罗大陆 | 女 |
| 古月方正 | 正派| 男 |
```
效果：

| 姓名   |  派别  |  性别 |     |
| :--- | :--: | --: | --- |
| 古月方源 |  魔道  |   男 |     |
| 古月娜  | 斗罗大陆 |   女 |     |
| 古月方正 |  正派  |   男 |     |

第二行**备注**:

| 左对齐  | 右对齐  | 居中对齐  |
| :--- | --: | :--: |
| ":--- "| "--:" | ":--:" |
