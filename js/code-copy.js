/**
 * One-click copy for code blocks (Rouge / highlighter-rouge)
 * Works with the table-based line-number layout used by Hux Blog.
 */
(function () {
  'use strict';

  // Inject styles
  var style = document.createElement('style');
  style.textContent = [
    '.highlight { position: relative; }',
    '.code-copy-btn {',
    '  position: absolute;',
    '  top: 8px;',
    '  right: 8px;',
    '  z-index: 10;',
    '  padding: 4px 10px;',
    '  font-size: 12px;',
    '  line-height: 1.4;',
    '  color: #abb2bf;',
    '  background: rgba(0,0,0,0.35);',
    '  border: 1px solid rgba(255,255,255,0.15);',
    '  border-radius: 4px;',
    '  cursor: pointer;',
    '  opacity: 0;',
    '  transition: opacity 0.2s, background 0.2s, color 0.2s;',
    '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;',
    '  user-select: none;',
    '}',
    '.highlight:hover .code-copy-btn,',
    '.code-copy-btn:focus { opacity: 1; }',
    '.code-copy-btn:hover {',
    '  background: rgba(0,0,0,0.55);',
    '  color: #fff;',
    '}',
    '.code-copy-btn.copied {',
    '  background: #0085a1;',
    '  color: #fff;',
    '  border-color: #0085a1;',
    '  opacity: 1;',
    '}',
    '@media (max-width: 480px) {',
    '  .code-copy-btn { opacity: 0.85; top: 6px; right: 6px; font-size: 11px; padding: 3px 8px; }',
    '}'
  ].join('\n');
  document.head.appendChild(style);

  function getCodeText(highlightEl) {
    // Prefer the actual code cell (skip line numbers)
    var codePre = highlightEl.querySelector('.rouge-code pre');
    if (codePre) {
      return codePre.innerText || codePre.textContent || '';
    }
    // Fallback: whole pre/code
    var pre = highlightEl.querySelector('pre') || highlightEl;
    return pre.innerText || pre.textContent || '';
  }

  function createButton() {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'code-copy-btn';
    btn.setAttribute('aria-label', '复制代码');
    btn.textContent = '复制';
    return btn;
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    // Fallback for older browsers / non-HTTPS
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
      // Avoid double-init
      if (block.querySelector('.code-copy-btn')) return;

      // Make sure the container can position the button
      if (window.getComputedStyle(block).position === 'static') {
        block.style.position = 'relative';
      }

      var btn = createButton();
      block.appendChild(btn);

      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var text = getCodeText(block).replace(/\n$/, ''); // trim trailing newline often added by pre
        copyText(text).then(function () {
          var original = btn.textContent;
          btn.textContent = '已复制';
          btn.classList.add('copied');
          setTimeout(function () {
            btn.textContent = original;
            btn.classList.remove('copied');
          }, 1600);
        }).catch(function () {
          btn.textContent = '失败';
          setTimeout(function () {
            btn.textContent = '复制';
          }, 1600);
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
