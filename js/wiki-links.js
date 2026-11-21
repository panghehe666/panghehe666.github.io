/* ============================================================
   PHH Blog · [[双链]] 渲染
   - [[文章标题]] / [[文章标题|显示文字]] → 文章链接
   - 目标文章不存在时,保留原文并标成「未解析」样式(虚线下划线)
   - 标题映射:/graph.json + 本地预览缓存(phh_local_posts)
   - local-preview.js 会动态插入内容,用 MutationObserver 兜底再扫
   ============================================================ */
(function () {
  'use strict';
  var MAP = null, obsTimer = null, mo = null;

  function loadMap() {
    if (MAP) return Promise.resolve(MAP);
    var base = {};
    return fetch('/graph.json?v=' + Date.now())
      .then(function (r) { return r.json(); })
      .then(function (d) {
        (d.posts || []).forEach(function (p) {
          if (p && p.t && p.u) base[String(p.t).trim()] = p.u;
        });
        return base;
      })
      .catch(function () { return base; })
      .then(function (m) {
        /* 合并本机刚保存、Pages 还没发布的文章 */
        try {
          var store = JSON.parse(localStorage.getItem('phh_local_posts') || '{}');
          Object.keys(store).forEach(function (k) {
            var rec = store[k] || {};
            if (rec.title && rec.url) m[String(rec.title).trim()] = rec.url;
            if (rec.title && !rec.url && k) {
              var mm = String(k).match(/^(\d{4})-(\d{1,2})-(\d{1,2})-(.+)\.(md|markdown)$/);
              if (mm) {
                var p2 = function (n) { return (n.length < 2 ? '0' : '') + n; };
                m[String(rec.title).trim()] =
                  '/' + mm[1] + '/' + p2(mm[2]) + '/' + p2(mm[3]) + '/' + mm[4] + '/';
              }
            }
          });
        } catch (e) {}
        MAP = m;
        return m;
      });
  }

  function injectStyle() {
    if (document.getElementById('post-wikilink-style')) return;
    var st = document.createElement('style');
    st.id = 'post-wikilink-style';
    st.textContent =
      '.post-wikilink{color:#0085a1;border-bottom:1px dashed rgba(0,133,161,.5);text-decoration:none;}' +
      '.post-wikilink:hover{border-bottom-style:solid;text-decoration:none;}' +
      '.post-wikilink-missing{color:#9aa5b1;border-bottom:1px dashed rgba(154,165,177,.6);cursor:help;}';
    (document.head || document.body).appendChild(st);
  }

  function hostEl() {
    return document.querySelector('article div.post-container') ||
           document.querySelector('div.post-container') ||
           document.querySelector('article') ||
           null;
  }

  function walkAndLink() {
    var host = hostEl();
    if (!host) return;
    loadMap().then(function (map) {
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
        if (par.closest && par.closest('.post-wikilink-missing')) continue;
        texts.push(n);
      }
      texts.forEach(function (tn) {
        var s = tn.nodeValue;
        var re = /\[\[([^\[\]\n|]{1,80})(?:\|([^\[\]\n]{1,80}))?\]\]/g;
        var frag = document.createDocumentFragment();
        var last = 0, m, changed = false;
        while ((m = re.exec(s))) {
          var key = m[1].trim();
          var label = String(m[2] || key).trim();
          var url = map[key];
          changed = true;
          if (m.index > last) frag.appendChild(document.createTextNode(s.slice(last, m.index)));
          var el;
          if (url) {
            el = document.createElement('a');
            el.href = url;
            el.className = 'post-wikilink';
          } else {
            el = document.createElement('span');
            el.className = 'post-wikilink-missing';
            el.title = '没有找到标题为「' + key + '」的文章';
          }
          el.textContent = label;
          frag.appendChild(el);
          last = m.index + m[0].length;
        }
        if (!changed) return;
        if (last < s.length) frag.appendChild(document.createTextNode(s.slice(last)));
        try { tn.parentNode.replaceChild(frag, tn); } catch (e) {}
      });
    });
  }

  function schedule() {
    if (obsTimer) clearTimeout(obsTimer);
    obsTimer = setTimeout(walkAndLink, 120);
  }

  function bindObserver() {
    if (mo || !window.MutationObserver) return;
    var host = hostEl();
    if (!host) return;
    mo = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        if (muts[i].addedNodes && muts[i].addedNodes.length) { schedule(); return; }
      }
    });
    try { mo.observe(host, { childList: true, subtree: true }); } catch (e) {}
  }

  function boot() {
    injectStyle();
    walkAndLink();
    bindObserver();
    /* 本地预览/私密解密是后插入的,再兜几次 */
    setTimeout(function () { walkAndLink(); bindObserver(); }, 1200);
    setTimeout(function () { walkAndLink(); bindObserver(); }, 3000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
