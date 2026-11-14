/* ============================================================
   PHH Blog · 本地即时预览
   刚保存的文章会缓存到本机 localStorage(phh_local_posts)。
   打开文章页时,若存在 2 小时内的本地版本,优先显示本地内容,
   不等 GitHub Pages 发布;可点 × 关闭预览、回到线上版本。
   ============================================================ */
(function () {
  'use strict';
  var file = window.__POST_FILE;
  if (!file) return;
  var store = null;
  try { store = JSON.parse(localStorage.getItem('phh_local_posts') || '{}'); } catch (e) { return; }
  var rec = store[file];
  if (!rec || !rec.ts) return;
  if (Date.now() - rec.ts > 2 * 3600 * 1000) return;   /* 超过 2 小时以线上为准 */

  var html = rec.html || '';
  if (!html && rec.md) {
    try {
      if (window.PrivateCrypto && PrivateCrypto.markdownToHtml) html = PrivateCrypto.markdownToHtml(rec.md);
    } catch (e) { html = ''; }
  }
  if (!html) return;

  var cont = document.querySelector('div.post-container');
  if (!cont) return;

  /* 找到正文与分页之间的隐藏分隔线,把本地内容插到它前面 */
  var marker = null;
  var hrs = cont.querySelectorAll('hr');
  for (var i = 0; i < hrs.length; i++) {
    if ((hrs[i].getAttribute('style') || '').indexOf('hidden') >= 0) { marker = hrs[i]; break; }
  }

  var wrap = document.createElement('div');
  wrap.className = 'post-content';
  wrap.innerHTML = html;

  var badge = document.createElement('div');
  badge.className = 'local-badge';
  badge.innerHTML = '<span class="local-badge-t">⚡ 正在显示本地最新版(刚刚保存)</span>' +
    '<span class="local-badge-s">Pages 发布后全网自动一致</span>' +
    '<button type="button" class="local-badge-x" aria-label="关闭本地预览">×</button>';

  if (marker) {
    cont.insertBefore(badge, marker);
    cont.insertBefore(wrap, marker);
  } else {
    cont.insertBefore(badge, cont.firstChild);
    cont.insertBefore(wrap, badge.nextSibling);
  }

  badge.querySelector('.local-badge-x').addEventListener('click', function () {
    wrap.remove();
    badge.remove();
    try {
      delete store[file];
      localStorage.setItem('phh_local_posts', JSON.stringify(store));
    } catch (e) {}
  });

  try {
    if (window.renderPostToc) window.renderPostToc(cont);
  } catch (e) {}
})();
