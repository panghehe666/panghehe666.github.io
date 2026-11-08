/* ============================================================
   PHH Blog · 管理员密钥(密文)
   由 /setup/ 页面用「管理员密码」加密后写入,明文永不进仓库。
   内容格式:AES-GCM(iv+ciphertext) 的 base64,解密后是
   {"gh":"github_pat_...","ds":"sk-...","kimi":"sk-..."}。
   未配置时为空字符串。
   ============================================================ */
window.SITE_SECRETS_CIPHER = "hc/0jSC+78r3u4AItrG8NrQU/Kk83lwftasrDlecsiJeGukaSWe7FnSYK944e+r8v/ABIshz23LnHBUfjzD3spX7xKFRDYA5uygY4kvEDJ956oFtFHQcrV0pgfyTEhjHxqlMiEXAT4+pormQqCMCsKusSIB5FPpbzWtedTc0Mc1WCR3RUL/0+0kV2TXmswWp+PEnTPV8fvoAXXTmFhKn/czMX1jGtV68wDUJ8DelL7Fff/gj0g1MQ6pwUk4N1hoQtk2r/ffEji/ptZd/g09e+EQo01KsV1kFxFWTO5GoctIaj7c8cp04pX+N";
