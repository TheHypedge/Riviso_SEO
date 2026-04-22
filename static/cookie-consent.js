(function () {
  var root = document.getElementById('aaCookieConsent');
  if (!root) return;

  var consent = window.AAAnalytics && window.AAAnalytics.consentKey ? window.AAAnalytics.consentKey : 'aa_cookie_consent_v1';

  function getChoice() {
    try { return (localStorage.getItem(consent) || '').trim(); } catch (e) { return ''; }
  }
  function setChoice(v) {
    try { localStorage.setItem(consent, v); } catch (e) {}
  }

  function show() {
    root.hidden = false;
  }
  function hide() {
    root.hidden = true;
  }

  function applyFromChoice() {
    var v = getChoice();
    if (v === 'accepted') {
      if (window.AAAnalytics && typeof window.AAAnalytics.enable === 'function') {
        window.AAAnalytics.enable();
      }
      hide();
      return;
    }
    if (v === 'rejected') {
      hide();
      return;
    }
    show();
  }

  root.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-aa-cookie]') : null;
    if (!btn) return;
    var action = btn.getAttribute('data-aa-cookie') || '';
    if (action === 'accept') {
      setChoice('accepted');
      if (window.AAAnalytics && typeof window.AAAnalytics.enable === 'function') {
        window.AAAnalytics.enable();
      }
      hide();
    } else if (action === 'reject') {
      setChoice('rejected');
      hide();
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyFromChoice);
  } else {
    applyFromChoice();
  }
})();

