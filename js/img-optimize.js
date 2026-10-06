/**
 * Blog image loading optimizations:
 * - loading="lazy" for below-the-fold images
 * - decoding="async"
 * - Prefer jsDelivr CDN for /img/ paths (faster edge cache)
 */
(function () {
  function optimizeImages() {
    var imgs = document.querySelectorAll(
      '.post-container img, article img, .post-content img'
    );
    var origin = window.location.origin;
    var cdnBase =
      'https://cdn.jsdelivr.net/gh/panghehe666/panghehe666.github.io@master';

    imgs.forEach(function (img, index) {
      // Lazy-load all except the first couple (likely above the fold)
      if (index > 0) {
        img.setAttribute('loading', 'lazy');
      }
      img.setAttribute('decoding', 'async');

      // Optional: route relative /img/ to jsDelivr for faster global delivery
      var src = img.getAttribute('src') || '';
      if (src.indexOf('/img/') === 0 && src.indexOf('cdn.jsdelivr.net') === -1) {
        img.setAttribute('src', cdnBase + src);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', optimizeImages);
  } else {
    optimizeImages();
  }
})();
