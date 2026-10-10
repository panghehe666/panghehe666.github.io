---
layout:       post
title:        "FreeSocks + FlClash：隐私优先的免费代理搭配教程"
author:       "PHH"
header-style: text
catalog:      true
tags:
    - 隐私
    - 开源分享
    - 代理
---

> 在尽可能少暴露身份的前提下，获得可用、稳定的网络出口。

* TOC
{:toc}

---

## 为什么选择这对组合

**FreeSocks** 是由美国 501(c)(3) 非营利组织 Unredacted 运营的免费开源代理服务，核心设计目标就是**隐私与反审查**：

- 无邮箱、无密码、无手机号
- 仅通过浏览器内 PoW 人类验证获得随机 32 位账户号码
- 不记录访问日志，不存储客户端 IP
- 提供 Xray 驱动的 VLESS 订阅链接
- 免费层有流量额度，捐赠可提升全网免费额度；付费会员可获无限流量

**FlClash** 是基于 ClashMeta（mihomo）的开源跨平台客户端（Windows / macOS / Linux / Android）：

- 完全开源（GPL-3.0）、无广告、无遥测
- 多端界面高度一致
- 支持系统代理 + TUN 模式
- 内置订阅管理、延迟测试、流量统计、WebDAV 同步

二者结合：用 FreeSocks 获取匿名订阅 → 用 FlClash 安全导入并管理，最大化减少身份暴露。

**官方链接：**

- FreeSocks 官网： [https://freesocks.org/](https://freesocks.org/)
- FreeSocks 源码： [https://github.com/unredacted/freesocks-control-plane](https://github.com/unredacted/freesocks-control-plane)
- FlClash GitHub： [https://github.com/chen08209/FlClash](https://github.com/chen08209/FlClash)
- FlClash 下载页： [https://chen08209.github.io/FlClash/](https://chen08209.github.io/FlClash/)
- FlClash Releases： [https://github.com/chen08209/FlClash/releases/latest](https://github.com/chen08209/FlClash/releases/latest)

---

## 一、获取 FreeSocks 订阅（隐私步骤）

1. 打开 [https://freesocks.org/](https://freesocks.org/)（建议已有代理或 Tor 环境下访问）。
2. 点击 **Try it now** 或 **Get a free account**。
3. 完成页面上的人类验证（浏览器内计算，无需填写任何个人信息）。
4. 系统生成 **32 位随机账户号码**。
   **务必立即复制并离线妥善保存**（这是唯一恢复账户的凭证，丢失无法找回）。
5. 登录后创建订阅（Subscription）：
   - 可选择 Freedom Mode（走 CDN 伪装）或 Privacy Mode（直连）。
   - 生成订阅 URL（Xray / VLESS 格式），页面同时提供 QR 码方便手机扫码。
6. 复制完整订阅链接备用。

**注意：**

- 免费层当前约有 50 GB/月流量限制（捐赠会提升全网额度）。
- 部分非高审查地区可能暂时无法直接获取免费密钥。
- 订阅链接本身已加密，但仍不要公开分享。

---

## 二、下载并安装 FlClash

1. 前往 [FlClash Releases](https://github.com/chen08209/FlClash/releases/latest)。
2. 根据系统选择安装包：
   - **Windows**：`*-windows-amd64-setup.exe` 或 portable zip
   - **macOS**：根据芯片选 `macos-arm64.dmg` 或 `macos-amd64.dmg`
   - **Android**：优先 `android-arm64-v8a.apk`
   - **Linux**：deb / rpm / AppImage
3. 安装前建议卸载其他代理软件，避免端口冲突。
4. 首次启动允许必要的网络/防火墙权限。

也可直接访问官网自动选择版本：[https://chen08209.github.io/FlClash/](https://chen08209.github.io/FlClash/)

---

## 三、在 FlClash 中导入 FreeSocks 订阅

1. 打开 FlClash。
2. 进入左侧 **「配置 / Profiles」**。
3. 点击右下角 **「+」**。
4. 选择 **「URL」**（Get profile from URL）。
5. 粘贴 FreeSocks 订阅链接，点击「提交 / 下载」。
6. 导入成功后启用该配置。
7. 进入 **「代理 / Proxies」**，测试延迟，选择可用节点。
8. 返回仪表盘：
   - 桌面端开启「系统代理」。
   - 需要全局代理时开启 **TUN 模式**（需管理员权限）。
   - 点击启动。
9. Android 端首次会弹出 VPN 授权，点击允许即可。

**更新订阅：** 在配置页面点击右上角刷新图标即可重新拉取最新节点。

---

## 四、推荐隐私增强设置

- **DNS**：使用加密 DNS（DoH/DoT），减少 DNS 泄露。
- **规则模式**：日常用规则分流，敏感场景可切全局。
- **WebDAV 同步**：多设备时可用，但注意 WebDAV 服务本身的隐私性。
- **端口**：默认 HTTP 7890 / SOCKS5 7891，可在「工具 → 网络」中修改。
- **账户号码备份**：将 FreeSocks 的 32 位账户号码放入加密笔记或密码管理器。

---

## 五、常见问题

- **导入失败**：检查链接是否完整、网络是否能访问 FreeSocks；可尝试镜像链接（会员功能）。
- **无法连接**：更换节点、切换 Freedom/Privacy 模式、检查本地防火墙。
- **流量耗尽**：免费层有限额，可捐赠支持或升级会员（支付过程不关联账户身份）。
- **端口冲突**：修改 FlClash 端口或关闭占用程序。
- **Android 后台被杀**：开启电池优化白名单 + 前台服务。

---

## 六、安全与使用提醒

本教程仅介绍公开可用的开源工具与服务，用于保护隐私与访问开放互联网。请遵守当地法律法规，合理使用。

- FreeSocks 与 FlClash 均不存储用户流量内容。
- 重要账户仍建议配合端到端加密工具（Signal、加密邮件等）。
- 定期更新客户端与节点。

---

**写在最后**

FreeSocks 的设计目标是「让审查环境下的用户也能低门槛获得可用出口」，FlClash 则提供了现代、干净、跨平台的客户端体验。两者搭配，在尽可能少暴露身份的前提下实现可用代理。

如果你在使用过程中有更好的隐私实践或遇到问题，欢迎交流。
