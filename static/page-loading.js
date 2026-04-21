/**
 * Global loading overlay: full-page navigations (form submit / form.submit()),
 * and in-flight fetch() calls (e.g. save via AJAX).
 * Opt out: add data-no-loading to a <form>, or id="generateArticleForm" (custom overlay).
 * wpPostForm (article edit) uses data-no-loading: submit may be prevented after unsaved / no-image
 * checks; the capture-phase listener would show this overlay before those handlers run. After checks
 * pass, article_edit calls __appPageLoadingShow('Posting to WordPress…').
 */
(function () {
  if (window.__appPageLoadingInit) return;
  window.__appPageLoadingInit = true;

  var overlay = null;
  var fetchDepth = 0;
  var showTimer = null;
  var visibleSince = 0;
  var pendingShowReason = "";

  // Avoid flashing the overlay for fast operations.
  var SHOW_DELAY_MS = 220;
  // Once visible, keep it visible briefly to avoid flicker.
  var MIN_VISIBLE_MS = 260;

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

  function _showNow(message) {
    var el = ensureOverlay();
    el.classList.add('is-visible');
    document.body.classList.add('app-page-loading-active');
    visibleSince = Date.now();
    if (message) {
      var p = el.querySelector('.app-page-loading-text');
      if (p) p.textContent = message;
    }
  }

  var DEFAULT_LOADING_TEXT = 'Loading…';

  function hide() {
    if (!overlay) return;
    // Cancel any pending delayed show.
    if (showTimer) {
      clearTimeout(showTimer);
      showTimer = null;
      pendingShowReason = "";
    }
    // If it's not visible yet, nothing else to do.
    if (!overlay.classList.contains('is-visible')) return;
    var elapsed = Date.now() - (visibleSince || 0);
    if (elapsed < MIN_VISIBLE_MS) {
      setTimeout(hide, MIN_VISIBLE_MS - elapsed);
      return;
    }
    overlay.classList.remove('is-visible');
    document.body.classList.remove('app-page-loading-active');
    visibleSince = 0;
    var p = overlay.querySelector('.app-page-loading-text');
    if (p) p.textContent = DEFAULT_LOADING_TEXT;
  }

  function showDelayed(message) {
    pendingShowReason = message || "";
    if (showTimer) return;
    showTimer = setTimeout(function () {
      showTimer = null;
      _showNow(pendingShowReason || "");
      pendingShowReason = "";
    }, SHOW_DELAY_MS);
  }

  function shouldSkipForm(form) {
    if (!form || form.tagName !== 'FORM') return true;
    if (form.hasAttribute('data-no-loading')) return true;
    if (form.id === 'generateArticleForm') return true;
    if (form.id === 'wpPostForm') return true;
    return false;
  }

  document.addEventListener(
    'submit',
    function (e) {
      var form = e.target;
      if (shouldSkipForm(form)) return;
      showDelayed();
    },
    true
  );

  var origSubmit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function () {
    if (!shouldSkipForm(this)) showDelayed();
    return origSubmit.apply(this, arguments);
  };

  var nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function () {
      var args = arguments;
      fetchDepth += 1;
      if (fetchDepth === 1) showDelayed();
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

  /**
   * For forms that opt out of the capture-phase submit hook (e.g. wpPostForm): call this only
   * after you know the submit will proceed (no preventDefault for unsaved / confirm dialogs).
   * @param {string} [message] - Optional label (default "Loading…").
   */
  window.__appPageLoadingShow = function (message) {
    // Explicit show should not be delayed: used for long-running actions.
    if (showTimer) {
      clearTimeout(showTimer);
      showTimer = null;
    }
    _showNow(message || '');
  };

  window.__appPageLoadingHide = hide;

  // If navigation happened while a modal was open (or Bootstrap glitched),
  // a stale backdrop can leave the new page looking blank/blocked.
  document.addEventListener('DOMContentLoaded', function () {
    try {
      var anyOpen = !!document.querySelector('.modal.show');
      if (!anyOpen) {
        document.querySelectorAll('.modal-backdrop').forEach(function (b) { b.remove(); });
        if (document.body) {
          document.body.classList.remove('modal-open');
          document.body.style.removeProperty('padding-right');
        }
      }
    } catch (e) {}
  });
})();
