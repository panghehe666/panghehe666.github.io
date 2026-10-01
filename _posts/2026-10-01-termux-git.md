---
layout:       post
title:        "Termux-git"
author:       "PHH"
header-style: text
catalog:      true
tags:
    - 开源分享
---
* TOC
{:toc}


# 1.环境准备

| 步骤 | 命令 | 说明 |
|---|---|---|
| 换清华源 | `sed -i 's@^ $deb.*stable main$$@#\1\ndeb https://mirrors.tuna.tsinghua.edu.cn/termux/termux-packages-24 stable main@' $PREFIX/etc/apt/sources.list && apt update && apt upgrade -y` | 加速依赖下载 |
| 安装必要软件 | `pkg install git openssh jq -y` | git、SSH、解析 JSON |

---

# 2.全局 Git 配置
```bash
git config --global user.name  "panghehe666"
git config --global user.email "15736701848@163.com"
```

___

# 3.生成并添加 SSH 公钥

| 步骤 | 命令 |
|---|---|
| 生成密钥 | `ssh-keygen -t rsa -b 4096 -C "15736701848@163.com"` |
| 查看公钥 | `cat ~/.ssh/id_rsa.pub` |
| 添加到 GitHub | 复制上一步输出 → GitHub **Settings** → **SSH and GPG keys** → **New SSH key** |

测试连通性  
```bash
ssh -T git@github.com
# 看到 Hi panghehe666! 即成功
```

___


# 4.克隆（或初始化）仓库

| 场景 | 命令 |
|---|---|
| 克隆全部公开仓库 | `curl -s https://api.github.com/users/panghehe666/repos?per_page=100 \| jq -r '.[].ssh_url' \| while read url; do git clone "$url"; done` |
| 已存在本地仓库 | 仅需把远程地址改成 SSH：<br>`git remote set-url origin git@github.com:panghehe666/仓库名.git` |
___

# 5.日常 Git 常用操作速查

| 操作 | 命令 |
|---|---|
| 查看状态 | `git status` |
| 添加文件到暂存区 | `git add 文件名` 或 `git add .` |
| 提交 | `git commit -m "描述"` |
| 推送到远程 | `git push` |
| 拉取最新代码 | `git pull` |
| 创建并切换分支 | `git checkout -b 新分支名` |
| 合并分支 | `git checkout main && git merge 新分支名` |
| 删除本地分支 | `git branch -d 分支名` |
| 删除远程分支 | `git push origin --delete 分支名` |
| 查看提交历史 | `git log --oneline` |
| 撤销上一次 commit（保留改动） | `git reset --soft HEAD~1` |
| 撤销上一次 commit（丢弃改动） | `git reset --hard HEAD~1` |
| 删除已跟踪文件 | `git rm 文件名 && git commit -m "remove 文件名"` |
___

# 6.一键模板：新增文件并推送

```bash
cd ~/life-skill                # 进入任意仓库
echo "# your code" > new.py    # 新建/编辑文件
vim new.py                     # 可选：用 vim 编辑
git add new.py
git commit -m "feat: add new.py"
git push
```
___

# 7.常见问题FAQ

| 问题 | 解决 |
|---|---|
| `Permission denied (publickey)` | 未添加公钥或 SSH agent 未启动，重新执行第 3 步 |
| `remote: Invalid username or password` | 远程地址仍是 HTTPS，执行<br>`git remote set-url origin git@github.com:<用户名>/<仓库>.git` |
| 端口 22 被墙 | 在 `~/.ssh/config` 中添加：<br><pre>Host github.com<br>  Hostname ssh.github.com<br>  Port 443</pre> |

---

> 🎉 **至此，Termux 到 GitHub 的无密码通道已完全打通，Enjoy Coding！**
