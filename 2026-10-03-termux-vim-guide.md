---
layout:       post
title:        "Termux Vim 指南：从零到 vim-plug"
author:       "PHH"
header-style: text
catalog:      true
tags:
    - 开源分享
    - Vim
    - Termux
---
* TOC
{:toc}


# 1. 为什么用 Vim + vim-plug

在 Termux 里写代码，Vim 几乎是默认选择：体积小、键盘友好、不依赖图形界面。

插件管理器这边，老配置常用 **Vundle**，但维护已基本停滞。更推荐 **[vim-plug](https://github.com/junegunn/vim-plug)**：

| 对比 | Vundle | vim-plug |
| :--- | :--- | :--- |
| 安装速度 | 串行 clone | 并行下载，更快 |
| 配置语法 | `Plugin 'xxx'` | `Plug 'xxx'` |
| 按需加载 | 较弱 | 支持 `on` / `for` 懒加载 |
| 维护状态 | 基本停滞 | 仍在活跃维护 |
| 体积 | 稍重 | 单文件，极轻 |

本仓库 [life-skill](https://github.com/panghehe666/life-skill) 的 `vimrc.txt` 已从 Vundle 迁移到 vim-plug，下面是完整可复现步骤。

---

# 2. 环境准备（Termux）

```bash
# 换源（可选，加速）后更新
pkg update && pkg upgrade -y

# 必备：Vim、Git、curl
pkg install vim git curl -y
```

确认版本：

```bash
vim --version | head -3
git --version
```

---

# 3. 安装 vim-plug

官方推荐一行命令（Linux / Termux 通用）：

```bash
curl -fLo ~/.vim/autoload/plug.vim --create-dirs \
  https://raw.githubusercontent.com/junegunn/vim-plug/master/plug.vim
```

> 若网络不稳，也可先 clone 再拷贝：
> ```bash
> git clone https://github.com/junegunn/vim-plug.git /tmp/vim-plug
> mkdir -p ~/.vim/autoload
> cp /tmp/vim-plug/plug.vim ~/.vim/autoload/
> ```

life-skill 的 `vimrc.txt` 里已经写了「空文件则自动下载」的逻辑，所以**只拷贝配置、不手动装 plug.vim 也能用**。

---

# 4. 使用本仓库的 vimrc

```bash
# 克隆（若尚未克隆）
git clone git@github.com:panghehe666/life-skill.git
cd life-skill

# 备份旧配置（有则备份）
[ -f ~/.vimrc ] && cp ~/.vimrc ~/.vimrc.bak

# 启用新配置
cp vimrc.txt ~/.vimrc
```

打开 Vim：

```bash
vim
```

首次启动会自动执行 `PlugInstall`（若 plug.vim 不存在会先下载）。也可手动：

```vim
:PlugInstall
```

安装完成后重启或：

```vim
:source $MYVIMRC
```

---

# 5. 配置解读（vimrc 要点）

核心结构：

```vim
" 自动安装 plug.vim（可选，首次打开时触发）
if empty(glob('~/.vim/autoload/plug.vim'))
  silent !curl -fLo ~/.vim/autoload/plug.vim --create-dirs
    \ https://raw.githubusercontent.com/junegunn/vim-plug/master/plug.vim
  autocmd VimEnter * PlugInstall --sync | source $MYVIMRC
endif

call plug#begin('~/.vim/plugged')

Plug 'morhetz/gruvbox'
Plug 'vim-airline/vim-airline'
Plug 'vim-airline/vim-airline-themes'

call plug#end()
```

| 功能 | 设置 |
| :--- | :--- |
| 主题 | `gruvbox` + `termguicolors` + `t_Co=256`（Termux 友好） |
| 状态栏 | airline，主题对齐 gruvbox，分隔符 `▶` / `◀` |
| 十字光标 | `cursorline` + `cursorcolumn` |
| 补全 | 字典 `~/.vim/dict/python.dic`，Tab / S-Tab 在菜单里移动 |
| 行号 | `set number` |

插件实际装在 `~/.vim/plugged/`，与旧 Vundle 的 `~/.vim/bundle/` 互不干扰。

---

# 6. 常用 vim-plug 命令

| 命令 | 作用 |
| :--- | :--- |
| `:PlugInstall` | 安装 vimrc 里声明的插件 |
| `:PlugUpdate` | 更新已安装插件 |
| `:PlugClean` | 删除已从 vimrc 移除的插件目录 |
| `:PlugStatus` | 查看插件状态 |
| `:PlugUpgrade` | 升级 vim-plug 自身 |

从 Vundle 迁过来时对照：

| Vundle | vim-plug |
| :--- | :--- |
| `:PluginInstall` | `:PlugInstall` |
| `:PluginUpdate` | `:PlugUpdate` |
| `:PluginClean` | `:PlugClean` |
| `:PluginList` | `:PlugStatus` |

清理旧 Vundle 残留（确认不再用后）：

```bash
rm -rf ~/.vim/bundle
```

---

# 7. 可选：Python 字典补全

```bash
mkdir -p ~/.vim/dict
# 把 python.dic（关键字列表，一行一个）放到该目录
```

vimrc 中已有：

```vim
set dictionary=~/.vim/dict/python.dic
set complete+=k
inoremap <expr><Tab> pumvisible() ? "\<C-n>" : "\<Tab>"
inoremap <expr><S-Tab> pumvisible() ? "\<C-p>" : "\<S-Tab>"
```

在插入模式下输入几个字母后按 `Ctrl-x Ctrl-k` 可从字典补全；有弹出菜单时用 Tab / S-Tab 选择。

---

# 8. 日常 Vim 速查（Termux 友好）

| 操作 | 按键 |
| :--- | :--- |
| 进入插入模式 | `i` / `a` / `o` |
| 回到普通模式 | `Esc` |
| 保存 | `:w` |
| 退出 | `:q` |
| 保存并退出 | `:wq` 或 `ZZ` |
| 强制退出不保存 | `:q!` |
| 行号跳转 | `42G` 或 `:42` |
| 搜索 | `/关键词` 然后 `n` / `N` |
| 撤销 / 重做 | `u` / `Ctrl-r` |
| 复制当前行 | `yy` |
| 粘贴 | `p` |
| 删除当前行 | `dd` |
| 多窗口横分 / 竖分 | `:sp` / `:vsp` |
| 窗口间切换 | `Ctrl-w` 再按方向键或 `h/j/k/l` |

---

# 9. 常见问题

| 问题 | 处理 |
| :--- | :--- |
| `:PlugInstall` 卡住或失败 | 检查网络；可改用镜像或手动 `git clone` 到 `~/.vim/plugged/插件名` |
| 颜色不对 / 灰扑扑 | 确认 `set termguicolors` 与 `set t_Co=256`；Termux 建议用较新版本 |
| airline 分隔符乱码 | 已改用普通三角 `▶◀`，无需 Powerline 字体 |
| 找不到 colorscheme gruvbox | 先执行 `:PlugInstall`，再 `:source $MYVIMRC` |
| 想加新插件 | 在 `call plug#begin` 与 `call plug#end` 之间加一行 `Plug '作者/仓库'`，保存后 `:PlugInstall` |

---

# 10. 相关链接

- 配置源文件：[life-skill/vimrc.txt](https://github.com/panghehe666/life-skill/blob/main/vimrc.txt)
- 仓库主页：[panghehe666/life-skill](https://github.com/panghehe666/life-skill)
- Termux → GitHub 无密码：[Termux-git](https://github.com/panghehe666/panghehe666.github.io/blob/master/2026-10-01-termux-git.md)
- vim-plug 官方：[junegunn/vim-plug](https://github.com/junegunn/vim-plug)

---

> 🎉 **至此，Termux 上 Vim + vim-plug + gruvbox 已就绪，可以安心写代码了。**
