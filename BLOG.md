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
- 特殊页面：`calendar.html`（日历/贡献图）、`models.html`（可视化模型实验室）、`admin.html`（私密文章管理）、`graph.html`+`graph.json`（文章链图，Obsidian 风格，导航栏入口）
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

## AI 问答模块（站内聊天）
- 前端：`_includes/ai-chat.html` + `css/ai-chat.css` + `js/ai-chat.js`，由 `_layouts/default.html` 全局引入
- 知识库：`chat-index.json`（Liquid 模板，每次构建自动汇总全部文章正文）
  - `chat-index.json` 只放公开文章；私密文章单独一个 `chat-private.json`，**只存密文**（`private_cipher`）
  - 两个文件都带 `?v=<构建时间戳>` 访问：绕开 GitHub Pages 的 `max-age=600` 和 `sw.js` 的
    stale-while-revalidate（否则改了文章要刷两次页面，AI 才看得到新版）
  - 管理员登录后前端才去拉 `chat-private.json`，用 `PrivateCrypto.decryptWithSession` 解密并入索引；
    非管理员既不下载、也解不开（密文本身是 AES-GCM，密钥来自管理员口令）
- 检索：前端 BM25 + 中文 bigram + 标题加权；默认只给命中那一**小节**的正文 + 开头引子（约 800~1400 字）
- 省 token：system 逐字固定（吃 DeepSeek 前缀缓存）；正文不够时模型输出 `[[MORE]]`，前端自动换整篇重发一次
- 两个模式（面板左下的胶囊，localStorage `phh_ai_mode`）：
  - **节能**：只给命中小节 → 不够时 `[[MORE]]` 升级为整篇
  - **强爽**：直接给整篇 → 不够时 `[[MORE]]` 升级为全站所有文章
- 多轮省 token：历史里存的是**带正文的完整消息**，同一篇文章第二轮起不再重发（`alreadySent` / `fullSent` 判断），
  且历史是稳定前缀 → DeepSeek 前缀缓存命中；追问（以「那/再/这…」开头）会优先接着上一篇聊
- 回答：DeepSeek `deepseek-chat`（「深入」开关切 `deepseek-reasoner`），SSE 流式
- 面向私有：**未登录管理员时 AI 组件整个不存在**——`ai-chat.js` 开头检测到没解锁就把 `#ai-chat`
  节点从 DOM 里摘掉并 return，不渲染悬浮球、不加载索引、不发任何请求；`default.html` 另有
  `html:not(.is-admin) #ai-chat{display:none}` 兜住首屏闪烁
- 三种接入方式（取值优先级从高到低）：
  1. **密钥信封**（默认，见下节）：管理员登录后 `sessionStorage` 里的 DeepSeek Key 自动生效，无需任何配置
  2. 访客自己在面板「设置」里填 API Key（存 localStorage，只在本人浏览器）
  3. 部署 `_tools/deepseek-proxy.js` 到 Cloudflare Worker，把地址填进 `_config.yml` 的
     `ai_chat_proxy`，访客就免填 Key
- 关闭整个模块：`_config.yml` 里 `ai_chat: false`

## 密钥信封与管理员登录（2026-11 改造）

**核心思路**：DeepSeek API Key 与 GitHub Token 用管理员密码加密后存进仓库的 `secrets.enc.json`。
仓库公开也不要紧——没有密码它就是一段废 Base64。登录后一个密码同时解锁三样东西：
私密文章解密、AI 助手、文章发布/改/删。

- **登录校验 = 能否解开信封**。`admin.html` 里原来那个公开的 SHA-256 口令哈希已删除，
  改 localStorage `blog_admin` 不再是管理员（`on()` 只看 `PrivateCrypto.isUnlocked()`）
- **信封格式**：`{"v":2,"s":<Base64 站点随机 salt>,"c":<Base64 IV+密文>,"k":["deepseek","github"],"created":<ISO>}`
  明文部分是 `{"deepseek":"sk-...","github":"github_pat_..."}`
- **密文格式两代并存**（`js/private-crypto.js` 自动识别，不会破坏旧文章）：
  - legacy：裸 Base64(IV12+密文)，salt 硬编码 `panghehe666-blog-private-v1`、PBKDF2 12 万次。
    只用于解密改造前已存在的私密文章
  - v2：`PHH2:` + Base64(IV12+密文)，PBKDF2 30 万次、salt 为站点级随机值（存在信封里，不随每条密文重复）。
    与 legacy 同构、只多 5 个字符前缀，所以私密文章的 front matter 体积不会膨胀。
    **前缀是必需的**——密文若是裸 JSON，以 `{` 开头会被 YAML 当成 flow mapping，
    写进 front matter 直接让整篇文章构建失败
- **密钥落 sessionStorage**（关标签页即清除）；登录页勾「记住此设备」才额外写 localStorage
- **管理页四个工具**：Secrets（更新信封里的密钥并重新提交）、Migrate（换密码后把 legacy
  私密文章用旧密码解开、新密钥重加密后提交，只跑一次）、Encrypt（单篇生成 v2 密文）、Posts（原有的增删改）
- **首次使用**：`secrets.enc.json` 不存在时管理页自动切到 First Run 界面，填密码 + 两个密钥
  → 加密 → 用刚填的 GitHub Token 把信封 PUT 进仓库 → 自动登录
- **已移除的第三方脚本**（都是能读 sessionStorage 的外部 JS，私有站不需要）：
  AdSense、Google Analytics、ghbtns Star iframe、cdnjs 的 fastclick。`_includes/ads.html` 已清空但保留文件，
  否则 `page.html` 里的 include 会报错
- **安全边界（务必记住）**：整套方案的强度 = 管理员密码强度。信封密文是公开的，
  可以无限次离线爆破，所以密码要 ≥ 20 位随机串，别用生日+姓名结构。
  密码忘了 = 私密文章和信封里的密钥一起永久丢失，无找回途径，必须离线备份
