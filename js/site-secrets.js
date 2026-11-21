/* ============================================================
   PHH Blog · 管理员密钥(密文)
   由 /setup/ 页面用「管理员密码」加密后写入,明文永不进仓库。
   内容格式:AES-GCM(iv+ciphertext) 的 base64,解密后是
   {"gh":"github_pat_...","ds":"sk-...","kimi":"sk-..."}。
   未配置时为空字符串。
   ============================================================ */
window.SITE_SECRETS_CIPHER = "Br82kDVjkq73v3oH/EUIohCaFBbGHnArVscPTNW/iDu27XbcHVWpuZw6blrybIQGqGPu7AJ0bSyMcnFtaCRACL5ki4YUcSVy9u+rQIfWIbAVC3IP8wRS/4fKI5Y6FgCi4F64mlEM+ep3OVaYLMbTgUlLMGkeKDKSUIWMt9CPiZk7d3UwsdJbtbdpH6IPI27awMjLoywufaQDKRnDXVraE+WMRivI4Zd+LFn0Vr9JR5q3JE6PomSdqAmk53z+Kipw8mLE5G1C9U79+JTGcrOJpYPOD4kwcIyNsLvne7TQskv9ltkNldKl4Ia9";
