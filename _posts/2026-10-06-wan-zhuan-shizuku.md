---
layout:       post
title:        "玩转Shizuku"
author:       "PHH"
header-style: text
catalog:      true
tags:
    - 开源分享
    - Android
    - 玩机
---

* TOC
{:toc}

> 今天带大家玩转一套「免 Root 玩机神器」全家桶！从权限框架到广告杀手，再到应用冻结，统统安排上。准备好了吗？起飞～ 🚀

## 1. Shizuku：玩机界的「瑞士军刀」

**GitHub 地址**：https://github.com/RikkaApps/Shizuku

Shizuku 是整个玩机生态的基石。它能让普通 App 通过 ADB 直接调用系统 API，不用 Root 也能干大事！

### 激活教程（无线调试版，推荐）

1. 开启开发者选项（连续点击「关于手机」里的版本号 7 次）。
2. 打开「USB 调试」和「无线调试」。
3. 打开 Shizuku → 点击「通过无线调试启动」→ 去系统设置里点「使用配对码配对设备」。
4. 通知栏会出现配对码输入框，填进去就完事。
5. 回到 Shizuku 点「启动」，看到「Shizuku 正在运行」就成功了！

**小米手机特别注意**：
去「设置 → 通知与状态栏 → 通知样式」把弹窗样式改成 **「原生模式」**（或「原生样式」）。不然配对码通知会闪退，气得你想砸手机 😤

另外记得打开「USB 调试（安全设置）」，不然权限会受限。

## 2. Shevery：Shizuku 的「豪华升级版」

**GitHub 地址**：https://github.com/HmnDev-Tech/shevery

Shevery 是 Shizuku 的现代化分支，换了 Material 3 界面，还加了开机自启、ADB 模块、终端（甚至带 AI）等超多好用功能。

![](https://cdn.jsdelivr.net/gh/panghehe666/panghehe666.github.io@b11fd1ce5a0a50c4f767cc3bb4e0190e2ae52981/img/in-post/wan-zhuan-shizuku/shevery-running.jpg)
*Shevery 14.1 运行中（adb 模式），已授权 4 个应用*

### 它和 Shizuku 的关系

- Shevery = 官方 Shizuku 的「增强管理器」
- 核心服务还是那一套，但管理体验更香
- **重要备注**：Shevery 和官方 Shizuku **只能同时安装一个**！安装前必须先卸载另一个，否则会冲突。

### 使用说明 + 开机自启教程

1. 卸载官方 Shizuku 后安装 Shevery。
2. 激活方式和官方几乎一样（无线调试配对）。
3. 开机自启：打开 Shevery → 设置 → 找到「通过无线调试开机自启」开关，打开它。开机时会短暂打开无线调试，再通过 ADB（TCP 5555）拉起服务，无需 Root，只要短暂连一下 Wi-Fi。
4. 建议顺手打开「错误保护」：服务异常或崩溃时会自动重启。
5. 首次可能需要授权「写入安全设置」权限，同意就行。
6. 重启后它会自动恢复无线调试并启动服务（小米用户可能还要手动确认一下「USB 调试安全设置」）。

![](https://cdn.jsdelivr.net/gh/panghehe666/panghehe666.github.io@master/img/in-post/wan-zhuan-shizuku/shevery-autostart.jpg)
*设置页：开机自启（无线调试）+ 错误保护。注意：Shevery 和官方 Shizuku 只能装一个*

搞定后，重启再也不用手动激活，真香！✨

## 3. Gama：一键切换 Vulkan / OpenGL

**GitHub 地址**：https://github.com/palincat/gama

Gama（Graphics API Manager）可以让你不 Root 就切换 GPU 渲染 API。

- **Vulkan** = 新版、更高效、更省电、更凉快 ❄️
- **OpenGL** = 旧版，兼容性更好，但性能和续航稍差

**强烈推荐改用 Vulkan！** 温度下来了，电池也更耐用。

![](https://cdn.jsdelivr.net/gh/panghehe666/panghehe666.github.io@master/img/in-post/wan-zhuan-shizuku/gama-vulkan.jpg)
*GAMA v1.4：当前渲染器已经切到 Vulkan*

### 使用教程

1. 先确保 Shizuku / Shevery 已激活并授权给 Gama。
2. 打开 Gama，点「Vulkan」即可强制使用 Vulkan。
3. 如果不舒服，随时切回 OpenGL。
4. 重启后 Gama 会尝试自动恢复你的选择（有时需要手动再点一次）。

一键操作，比敲命令行爽多了！🎮

## 4. GKD：广告终结者

**GitHub 地址**：https://github.com/gkd-kit/gkd

GKD 是基于无障碍服务的「自动点击」神器，专门用来跳过开屏广告、关闭各种弹窗。规则全靠订阅，社区维护得非常猛。

![](https://cdn.jsdelivr.net/gh/panghehe666/panghehe666.github.io@master/img/in-post/wan-zhuan-shizuku/gkd-home.jpg)
*GKD 首页：无障碍正在运行，已开启 3 条订阅*

### 使用教程

1. 安装后开启无障碍服务。
2. 去「订阅」页面点右下角「+」，粘贴订阅链接。
3. 开启规则匹配（顶部闪电图标）。
4. 建议先只开「开屏广告」类规则，其他按需开启，别一口气全开，不然可能卡顿。

**推荐订阅链接**（任选一个，国内友好）：

- 奥怪订阅：`https://cdn.jsdelivr.net/gh/aoguai/subscription@custom/dist/aoguai_gkd.json5`
- 甘霖订阅：`https://cdn.jsdelivr.net/npm/@ganlinte/gkd-subscription@latest/dist/ganlin_gkd.json5`
- 整合懒人版：`https://cdn.jsdelivr.net/gh/oklazeno/gkd-subscription@main/gkd.json5`

广告？不存在的！😎

## 5. 雹（Hail）：应用冻结专家

**GitHub 地址**：https://github.com/aistra0528/Hail

雹可以「冻结」不常用的 App，让它们彻底休息，省内存、省电、还干净。支持停用、隐藏、暂停等多种模式。

![](https://cdn.jsdelivr.net/gh/panghehe666/panghehe666.github.io@master/img/in-post/wan-zhuan-shizuku/hail-home.jpg)
*雹首页：被冻结的应用会变成灰色，点右下角雪花就能一键冻结*

### 使用教程

1. 安装后选择工作模式（推荐 **Shizuku 模式**，免 Root 最稳）。
2. 授权 Shizuku 权限。
3. 切到「应用」页，勾选想冻的 App，再回首页点冻结就行。
4. 需要用的时候再解冻，秒回原状。

![](https://cdn.jsdelivr.net/gh/panghehe666/panghehe666.github.io@master/img/in-post/wan-zhuan-shizuku/hail-apps.jpg)
*应用列表：打勾就是准备冻结的对象*

系统预装的垃圾 App 直接冻起来，手机瞬间清爽！❄️

---

## 结语

从 Shizuku 打通权限，到 Shevery 让它自动跑，再到 Gama 优化渲染、GKD 干掉广告、雹清理后台……这一套下来，你的安卓手机已经从「能用」变成「真香」了。

玩机最开心的瞬间，就是看着一堆原本需要 Root 才能搞定的事情，被几个开源工具轻松拿下。

去 GitHub 给这些项目点个 Star 吧，开发者们真的很不容易。

下次见，继续一起折腾～ ✨

> 声明：本文仅供学习交流，操作前请备份重要数据，风险自负。
