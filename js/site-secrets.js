/* ============================================================
   PHH Blog · 管理员密钥(密文)
   由 /setup/ 页面用「管理员密码」加密后写入,明文永不进仓库。
   内容格式:AES-GCM(iv+ciphertext) 的 base64,解密后是
   {"gh":"github_pat_...","ds":"sk-..."}。
   未配置时为空字符串。
   ============================================================ */
window.SITE_SECRETS_CIPHER = "auf2LwAtaRxJ6Emj0/xbTa4QkF0oeyBCMH1AeAgLaw1THstqmotNg/EnCsnk/xma4g0YH0rRDAgxoEjvBXaX7pCbvAOQ1qD20j3U/9evjFCfYlehOK0g3SlqjtAvZLNNHu0NRsKkck1vw7PwHJdU5yaMWExSe5doCVt5Tq2ZVwUGpISAEYzMEi+n5B7EY722S9wZK/G6o/IeNTvNIQ2lH8s1l/6TOY47V/VHPos=";
