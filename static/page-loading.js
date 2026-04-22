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
  // Hard safety: never keep the overlay forever (e.g. aborted fetch, navigation race).
  var MAX_VISIBLE_MS = 15000;
  var maxVisibleTimer = null;

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
    if (maxVisibleTimer) clearTimeout(maxVisibleTimer);
    maxVisibleTimer = setTimeout(function () {
      // If something got stuck, unblock the UI.
      fetchDepth = 0;
      hide();
    }, MAX_VISIBLE_MS);
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
    if (maxVisibleTimer) {
      clearTimeout(maxVisibleTimer);
      maxVisibleTimer = null;
    }
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
      // Only show the full-page loader for our own app requests.
      // Third-party scripts (analytics, tag manager, etc.) may use fetch() on page load and
      // should not block the UI with a modal-like overlay.
      var url = '';
      try {
        url = String(args[0] || '');
      } catch (e) {}
      var isSameOrigin = false;
      try {
        var u = new URL(url, window.location.href);
        isSameOrigin = u.origin === window.location.origin;
      } catch (e2) {
        // Non-URL fetch arg (Request object) or invalid; assume same-origin to be safe.
        isSameOrigin = true;
      }

      var track = !!isSameOrigin;
      if (track) {
        fetchDepth += 1;
        if (fetchDepth === 1) showDelayed();
      }

      var p = nativeFetch.apply(this, args);
      if (!track) return p;

      return p.finally(function () {
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

  // If a Bootstrap modal is about to open, never block the UI with the page overlay.
  // This prevents a stuck "Loading…" overlay from hiding modals/backdrops.
  document.addEventListener(
    'show.bs.modal',
    function () {
      fetchDepth = 0;
      hide();
    },
    true
  );

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
})();
