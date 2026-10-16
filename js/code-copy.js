/**
 * One-click copy for code blocks (Rouge / highlighter-rouge)
 * Subtle icon button + green checkmark feedback.
 */
(function () {
  'use strict';

  var COPY_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
  var CHECK_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';

  // Inject styles
  var style = document.createElement('style');
  style.textContent = [
    '.highlight { position: relative; }',
    '.code-copy-btn {',
    '  position: absolute;',
    '  top: 6px;',
    '  right: 6px;',
    '  z-index: 10;',
    '  display: flex;',
    '  align-items: center;',
    '  justify-content: center;',
    '  width: 28px;',
    '  height: 28px;',
    '  padding: 0;',
    '  color: #7f848e;',
    '  background: transparent;',
    '  border: none;',
    '  border-radius: 4px;',
    '  cursor: pointer;',
    '  opacity: 0;',
    '  transition: opacity 0.15s ease, color 0.15s ease, background 0.15s ease;',
    '  user-select: none;',
    '}',
    '.highlight:hover .code-copy-btn,',
    '.code-copy-btn:focus { opacity: 0.7; }',
    '.code-copy-btn:hover {',
    '  opacity: 1;',
    '  color: #abb2bf;',
    '  background: rgba(255,255,255,0.08);',
    '}',
    '.code-copy-btn.copied {',
    '  opacity: 1;',
    '  color: #3dd68c;',
    '  background: transparent;',
    '}',
    '.code-copy-btn svg {',
    '  display: block;',
    '  pointer-events: none;',
    '}',
    '@media (max-width: 480px) {',
    '  .code-copy-btn { opacity: 0.55; width: 26px; height: 26px; }',
    '}'
  ].join('\n');
  document.head.appendChild(style);

  function getCodeText(highlightEl) {
    var codePre = highlightEl.querySelector('.rouge-code pre');
    if (codePre) {
      return codePre.innerText || codePre.textContent || '';
    }
    var pre = highlightEl.querySelector('pre') || highlightEl;
    return pre.innerText || pre.textContent || '';
  }

  function createButton() {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'code-copy-btn';
    btn.setAttribute('aria-label', '复制代码');
    btn.setAttribute('title', '复制');
    btn.innerHTML = COPY_ICON;
    return btn;
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try {
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) resolve();
        else reject(new Error('execCommand failed'));
      } catch (e) {
        document.body.removeChild(ta);
        reject(e);
      }
    });
  }

  function init() {
    var blocks = document.querySelectorAll('div.highlight, pre.highlight');
    blocks.forEach(function (block) {
      if (block.querySelector('.code-copy-btn')) return;

      if (window.getComputedStyle(block).position === 'static') {
        block.style.position = 'relative';
      }

      var btn = createButton();
      block.appendChild(btn);

      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var text = getCodeText(block).replace(/\n$/, '');
        copyText(text).then(function () {
          btn.innerHTML = CHECK_ICON;
          btn.classList.add('copied');
          btn.setAttribute('title', '已复制');
          setTimeout(function () {
            btn.innerHTML = COPY_ICON;
            btn.classList.remove('copied');
            btn.setAttribute('title', '复制');
          }, 1500);
        }).catch(function () {
          // silent fail, keep icon
        });
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
