/* ============================================================
   PHH Blog · [[双链]] 渲染
   文章正文里的 [[文章标题]] / [[文章标题|显示文字]] 自动变成链接。
   标题→链接的映射来自 /graph.json(构建时生成)。
   ============================================================ */
(function () {
  'use strict';
  var MAP = null;

  function loadMap() {
    if (MAP) return Promise.resolve(MAP);
    return fetch('/graph.json?v=' + Date.now())
      .then(function (r) { return r.json(); })
      .then(function (d) {
        MAP = {};
        (d.posts || []).forEach(function (p) {
          if (p && p.t && p.u) MAP[String(p.t).trim()] = p.u;
        });
        return MAP;
      })
      .catch(function () { MAP = {}; return MAP; });
  }

  function injectStyle() {
    if (document.getElementById('post-wikilink-style')) return;
    var st = document.createElement('style');
    st.id = 'post-wikilink-style';
    st.textContent = '.post-wikilink{color:#0085a1;border-bottom:1px dashed rgba(0,133,161,.5);text-decoration:none;}' +
      '.post-wikilink:hover{border-bottom-style:solid;text-decoration:none;}';
    (document.head || document.body).appendChild(st);
  }

  function walkAndLink() {
    var host = document.querySelector('article .post-container') ||
               document.querySelector('article') ||
               document.querySelector('.post-container') ||
               null;
    if (!host) return;
    loadMap().then(function (map) {
      if (!map || !Object.keys(map).length) return;
      var walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, null);
      var texts = [], n;
      while ((n = walker.nextNode())) {
        var v = n.nodeValue;
        if (!v || v.indexOf('[[') < 0) continue;
        var par = n.parentNode;
        if (!par) continue;
        var tag = par.nodeName;
        if (tag === 'PRE' || tag === 'CODE' || tag === 'A' || tag === 'SCRIPT' ||
            tag === 'STYLE' || tag === 'TEXTAREA') continue;
        texts.push(n);
      }
      texts.forEach(function (tn) {
        var s = tn.nodeValue;
        var re = /\[\[([^\[\]\n|]{1,80})(?:\|([^\[\]\n]{1,80}))?\]\]/g;
        var frag = document.createDocumentFragment();
        var last = 0, m, changed = false;
        while ((m = re.exec(s))) {
          var key = m[1].trim();
          var url = map[key];
          if (!url) continue;
          changed = true;
          if (m.index > last) frag.appendChild(document.createTextNode(s.slice(last, m.index)));
          var a = document.createElement('a');
          a.href = url;
          a.className = 'post-wikilink';
          a.textContent = String(m[2] || key).trim();
          frag.appendChild(a);
          last = m.index + m[0].length;
        }
        if (!changed) return;
        if (last < s.length) frag.appendChild(document.createTextNode(s.slice(last)));
        try { tn.parentNode.replaceChild(frag, tn); } catch (e) {}
      });
    });
  }

  function boot() {
    injectStyle();
    walkAndLink();
    /* 私密文章是解密后插入的 HTML,延迟再扫两次 */
    setTimeout(walkAndLink, 1800);
    setTimeout(walkAndLink, 4000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
