---
layout:       post
title:        "玩转 DeepSeek Harness 安卓端"
author:       "PHH"
header-style: text
catalog:      true
tags:
    - 开源分享
    - 前沿科技
---

<div class="post-toc" style="background:#f7f9fb;border:1px solid #e3e8ee;border-left:4px solid #0a84ff;border-radius:8px;padding:14px 18px 10px;margin:8px 0 28px;">
<strong style="font-size:16px;">📑 目录</strong>
<ul style="margin:10px 0 0;padding-left:22px;line-height:1.9;">
<li><a href="#一简介deepseek-harness-是什么">一、简介：DeepSeek Harness 是什么</a></li>
<li><a href="#二配置教程小米">二、配置教程（小米）</a>
  <ul style="margin:2px 0 2px;padding-left:20px;">
  <li><a href="#21-下载安装">2.1 下载安装</a></li>
  <li><a href="#22-打不开多半是-webview-版本太低">2.2 打不开？多半是 WebView 版本太低</a></li>
  </ul>
</li>
<li><a href="#三使用方法">三、使用方法</a>
  <ul style="margin:2px 0 2px;padding-left:20px;">
  <li><a href="#31-配置-deepseek-api-key必须">3.1 配置 DeepSeek API Key（必须）</a></li>
  <li><a href="#32-配置插件可选">3.2 配置插件（可选）</a></li>
  <li><a href="#33-在-githubio-上写文章生成-token-教程">3.3 在 github.io 上写文章：生成 Token 教程</a></li>
  <li><a href="#34-使用体验和-grok-比一比">3.4 使用体验：和 Grok 比一比</a></li>
  </ul>
</li>
<li><a href="#结语">结语</a></li>
</ul>
</div>

## 一、简介：DeepSeek Harness 是什么

**DeepSeek Harness**，简称 **DSH**，是 DeepSeek 推出的开源项目，核心理念一句话概括：**"Everything is a Plugin."**——万物皆插件。

它把 AI 助手拆成一个个可插拔的模块（插件），你可以按需组合出属于自己的 AI 环境：记忆、视觉、通知、终端、模型接入……想加什么能力，装个插件就行。

**安卓端**则是把 DSH 内核打包成可直接安装的 APK，项目叫 **dsh-mobile-apk**，本质是「WebView UI + 内嵌 Termux 运行时快照」，解压即跑，让 DSH 能在手机上本地运行。装好之后，你就能让 AI：

- 直接跟你对话、写文章、写代码、改文件
- 操作手机（配合 Shizuku / ADB，免 root 也能用）
- 甚至让 AI 帮你把文章写好了直接推到 GitHub Pages 博客

![dsh-mobile 启动界面：探索未至之境](/img/in-post/2026-10-17-dsh-android/02-app-main.jpg)

## 二、配置教程（小米）

### 2.1 下载安装

打开 GitHub 发布页，下载 APK（小米手机选 arm64 版）：

- 发布页：<https://github.com/kelai141/dsh-mobile-apk/releases/tag/v0.14.7>
- arm64 直链：<https://github.com/kelai141/dsh-mobile-apk/releases/download/v0.14.7/dsh-mobile-apk-v0.14.7-arm64.apk>
- x86_64（模拟器用）：<https://github.com/kelai141/dsh-mobile-apk/releases/download/v0.14.7/dsh-mobile-apk-v0.14.7-x86_64.apk>

![dsh-mobile-apk v0.14.7 发布页](/img/in-post/2026-10-17-dsh-android/01-release-v0.14.7.jpg)

装好后如果能正常打开、正常对话，那**直接开耍**就行，下面一节可以跳过。

### 2.2 打不开？多半是 WebView 版本太低

如果安装后打开白屏、报错或者界面加载不出来，最常见的原因就是**系统 WebView 版本太低**。dsh-mobile 的 UI 跑在 WebView 里，对内核版本有一定要求。

解决办法分两步：

**① 关闭 MIUI 优化**

1. 打开「设置 → 我的设备 → 全部参数」，连续点击「MIUI 版本」7 次，开启**开发者选项**
2. 进入「设置 → 更多设置 → 开发者选项」
3. 找到「**启用 MIUI 优化**」，把它**关闭**

![开发者选项里的「启用 MIUI 优化」开关，默认是开着的，关掉它](/img/in-post/2026-10-17-dsh-android/03-miui-optimization.jpg)

> 小米的 MIUI 优化有时会干扰 WebView 组件的加载和更新，关掉后能减少不少诡异问题。

**② 升级 Android System WebView**

去 apklinker 下载最新的 Android System WebView 并安装（注意：下载源在境外，**需要魔法**，不会科学上网的可以看我这篇[《FreeSocks + FlClash：免费代理搭配教程》](https://panghehe666.github.io/2026/10/10/freesocks-flclash-privacy/)）：

- Android System WebView 149.0.7827.164：<https://www.apklinker.com/apk/google-llc/android-system-webview/android-system-webview-149-0-7827-164-release/android-system-webview-149-0-7827-164-android-apk-download/start/>

![apklinker 上的 Android System WebView 149.0.7827.164](/img/in-post/2026-10-17-dsh-android/04-apklinker-webview.jpg)

下载安装后，重新打开 dsh-mobile，一般就能正常跑起来了。

## 三、使用方法

### 3.1 配置 DeepSeek API Key（必须）

DSH 本身不内置模型服务，调用 DeepSeek 模型需要 API Key，这一步是**必须**的：

1. 打开 <https://platform.deepseek.com> ，注册 / 登录
2. 进入「API Keys」页面，点「创建 API Key」，复制并妥善保存（Key 只显示一次）
3. 回到 DSH，在设置里配置模型提供方（Provider / 模型路由），把 API Key 填进去
4. 配置好之后就能正常对话了

![DeepSeek 开放平台，API Key 在「API Keys」页面创建](/img/in-post/2026-10-17-dsh-android/05-deepseek-platform.jpg)

### 3.2 配置插件（可选）

插件是 DSH 的灵魂，但**不装也能用**，装了能解锁更多能力。可以去插件市场按需搜索安装，比如记忆、视觉、通知、终端 UI 等等。建议按需安装、别贪多，装太多反而拖慢启动速度。

### 3.3 在 github.io 上写文章：生成 Token 教程

想让 AI 帮你把文章直接推送到 GitHub Pages 博客，需要给一个 **GitHub Token** 授权。步骤如下：

1. 打开 GitHub，点右上角头像 → **Settings**
2. 左侧拉到最下面 → **Developer settings**
3. 选 **Personal access tokens** → **Fine-grained tokens**（推荐）→ **Generate new token**
4. 按需配置：
   - **Repository access** 选「Only select repositories」，只勾你的博客仓库（如 `panghehe666/panghehe666.github.io`）
   - **Permissions** 里把 `Contents` 设为 **Read and write**（写文章够用了）
   - 有效期建议设短一点，比如 7 天
5. 点 Generate，复制生成的 token（**只显示一次**）

拿到 token 后，在 DSH 里跟 AI 说「帮我写篇文章发到博客」，把 token 和文章内容给它，它就会帮你写好 Markdown、放进 `_posts/`、提交并推送。

> ⚠️ 安全提示：token 相当于你的账号密码，用完记得回 GitHub 里 **Revoke（撤销）**；也不要把它贴到公开的地方。

#### ⚠️ 容易踩的坑（我亲测踩过）

生成 token 时有几个细节特别容易选错，选错之后推文章时的报错很迷惑：

1. **Repository access 别选「Public repositories (read-only)」**——这个选项名字里就带 read-only，选它只能读不能写，推送时直接 403。
   - 正确做法：选「Only select repositories」，然后手动勾选你的博客仓库。
2. **Contents 权限必须是 Read and write**——fine-grained token 默认不带任何仓库权限，必须点「+」手动把 `Contents` 加成 **Read and write**，否则一样 403。
3. **报错认准这一条**：如果推送时看到 `Resource not accessible by personal access token`，基本就是上面两条之一没配对，回去检查 token 权限即可。
4. **token 只显示一次**：生成后立刻复制保存，关掉页面就再也看不到了。

我第一次就是选了「Public repositories (read-only)」，被 403 卡了半天，重新生成正确权限的 token 后一次就通了。所以这一步别嫌麻烦，权限对着设好，后面就顺了。

### 3.4 使用体验：和 Grok 比一比

用了这段时间，简单说下主观感受：

**优点**

- **不用翻墙**：相比 Grok，DSH 走 DeepSeek 国内服务，直连即可，省了梯子
- **逻辑更强**：推理和逻辑性上，个人体感比 Grok 更扎实
- **开源可折腾**：Everything is a Plugin，插件生态自由度高，还能本地运行、私有化部署
- **能操作手机**：配合 Shizuku / ADB，免 root 就能让 AI 点按、滚动、打开 App

**不足**

- **联通性不如 Grok**：Grok 的联通器（连接各种应用和服务）更方便，DSH 目前这块相对弱一些
- **提交文章略麻烦**：要把文章推到博客，得先搞 token、走 Git 流程，比 Grok 的一键发布繁琐一点

## 结语

DeepSeek Harness 安卓端，让「AI 装进手机、替我干活」这件事变得触手可及——而且是开源的、免翻墙的、能自己折腾的。虽然联通性和发布流程还有改进空间，但作为一个刚起步不久的开源项目，它的插件化思路和本地运行能力已经很能打了。

如果你也喜欢折腾，不妨装上试试，把手机变成自己的 AI 工作台。
