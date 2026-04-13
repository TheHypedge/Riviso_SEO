/**
 * Global loading overlay: full-page navigations (form submit / form.submit()),
 * and in-flight fetch() calls (e.g. save via AJAX).
 * Opt out: add data-no-loading to a <form>, or id="generateArticleForm" (custom overlay).
 */
(function () {
  if (window.__appPageLoadingInit) return;
  window.__appPageLoadingInit = true;

  var overlay = null;
  var fetchDepth = 0;

  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'appPageLoadingOverlay';
    overlay.className = 'app-page-loading-overlay';
    overlay.setAttribute('aria-busy', 'true');
    overlay.setAttribute('aria-live', 'polite');
    overlay.innerHTML =
      '<div class="app-page-loading-card">' +
      '<div class="app-page-loading-spinner" role="status" aria-hidden="true"></div>' +
      '<p class="app-page-loading-text">Loading…</p>' +
      '</div>';
    document.body.appendChild(overlay);
    return overlay;
  }

  function show() {
    var el = ensureOverlay();
    el.classList.add('is-visible');
    document.body.classList.add('app-page-loading-active');
  }

  function hide() {
    if (!overlay) return;
    overlay.classList.remove('is-visible');
    document.body.classList.remove('app-page-loading-active');
  }

  function shouldSkipForm(form) {
    if (!form || form.tagName !== 'FORM') return true;
    if (form.hasAttribute('data-no-loading')) return true;
    if (form.id === 'generateArticleForm') return true;
    return false;
  }

  document.addEventListener(
    'submit',
    function (e) {
      var form = e.target;
      if (shouldSkipForm(form)) return;
      show();
    },
    true
  );

  var origSubmit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function () {
    if (!shouldSkipForm(this)) show();
    return origSubmit.apply(this, arguments);
  };

  var nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function () {
      var args = arguments;
      fetchDepth += 1;
      if (fetchDepth === 1) show();
      return nativeFetch.apply(this, args).finally(function () {
        fetchDepth -= 1;
        if (fetchDepth <= 0) {
          fetchDepth = 0;
          hide();
        }
      });
    };
  }

  window.addEventListener('pageshow', function (ev) {
    fetchDepth = 0;
    hide();
    if (ev.persisted) hide();
  });
})();
