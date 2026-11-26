/* Noifla Digital Studio — interazioni e animazioni (JavaScript vanilla).
   Nessuna libreria tranne Bootstrap (modale). Le animazioni usano
   IntersectionObserver, requestAnimationFrame e transizioni CSS. */
(function () {
  'use strict';

  var N = window.NOIFLA;
  var WA_NUMBER = '393522230127'; // WhatsApp Business (formato internazionale, senza +)
  var CONSENT_KEY = 'noifla_cookie_consent';
  var reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var finePointer = matchMedia('(hover: hover) and (pointer: fine)').matches;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var clamp = function (v, a, b) { return Math.min(b, Math.max(a, v)); };
  var sectorById = function (id) { return N.SECTORS.filter(function (s) { return s.id === id; })[0]; };

  document.documentElement.classList.add('js');
  if (reduced) document.documentElement.classList.add('reduced');
  $$('.js-year').forEach(function (el) { el.textContent = new Date().getFullYear(); });

  /* ---------- un solo ciclo per tutto ciò che dipende dallo scroll ---------- */
  var scrollers = [];
  var ticking = false;
  function onScrollFrame() {
    ticking = false;
    var y = window.scrollY;
    for (var i = 0; i < scrollers.length; i++) scrollers[i](y);
  }
  function requestScrollFrame() { if (!ticking) { ticking = true; requestAnimationFrame(onScrollFrame); } }
  addEventListener('scroll', requestScrollFrame, { passive: true });
  addEventListener('resize', requestScrollFrame);

  /* ---------- banner cookie + Google Consent Mode ---------- */
  (function cookies() {
    window.dataLayer = window.dataLayer || [];
    function gtag() { window.dataLayer.push(arguments); }
    // tutto negato finché l'utente non sceglie (compatibile con GTM e Cookiebot)
    gtag('consent', 'default', { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', analytics_storage: 'denied', wait_for_update: 500 });
    var banner = $('#cookieBanner');
    if (!banner) return;
    var panel = $('#cookiePanel'), box = $('#cookieAnalytics');
    var btn = { accept: $('#cookieAccept'), reject: $('#cookieReject'), custom: $('#cookieCustomize'), save: $('#cookieSave') };
    function read() {
      try { var v = JSON.parse(localStorage.getItem(CONSENT_KEY)); if (v) return v; } catch (e) { /* storage non disponibile */ }
      var m = document.cookie.match(/(?:^|; )noifla_consent=([^;]*)/);
      try { return m ? JSON.parse(decodeURIComponent(m[1])) : null; } catch (e) { return null; }
    }
    var analyticsLoaded = false;
    // Punto di integrazione: caricare qui Google Tag Manager / Analytics, solo dopo il consenso.
    function loadAnalytics() {
      if (analyticsLoaded) return; analyticsLoaded = true;
      // var s = document.createElement('script'); s.async = true;
      // s.src = 'https://www.googletagmanager.com/gtm.js?id=GTM-XXXXXXX'; document.head.appendChild(s);
    }
    function apply(c) { gtag('consent', 'update', { analytics_storage: c.analytics ? 'granted' : 'denied' }); if (c.analytics) loadAnalytics(); }
    function show() { banner.hidden = false; requestAnimationFrame(function () { requestAnimationFrame(function () { banner.classList.add('is-in'); }); }); }
    function hide() { banner.classList.remove('is-in'); setTimeout(function () { banner.hidden = true; }, 450); }
    function save(analytics) {
      var c = { necessary: true, analytics: !!analytics, ts: Date.now() };
      try { localStorage.setItem(CONSENT_KEY, JSON.stringify(c)); } catch (e) { /* ignora */ }
      document.cookie = 'noifla_consent=' + encodeURIComponent(JSON.stringify(c)) + '; max-age=15552000; path=/; SameSite=Lax';
      apply(c); hide();
    }
    btn.accept.addEventListener('click', function () { save(true); });
    btn.reject.addEventListener('click', function () { save(false); });
    btn.save.addEventListener('click', function () { save(box.checked); });
    btn.custom.addEventListener('click', function () {
      var open = panel.hidden; panel.hidden = !open; btn.save.hidden = !open;
      btn.custom.setAttribute('aria-expanded', String(open));
    });
    $$('[data-cookie-prefs]').forEach(function (b) {
      b.addEventListener('click', function () { box.checked = !!(read() || {}).analytics; show(); });
    });
    var stored = read();
    if (stored) apply(stored); else setTimeout(show, 1500);
  })();

  if (!N || !N.mockups) return; // pagine legali: basta il banner

  /* ---------- nav: sparisce scendendo, torna risalendo ---------- */
  (function nav() {
    var el = $('[data-nav]');
    if (!el) return;
    var last = window.scrollY;
    scrollers.push(function (y) {
      var half = innerHeight * 0.5;
      if (y < half) el.classList.remove('is-hidden');
      else if (y > last + 2) el.classList.add('is-hidden');
      else if (y < last - 2) el.classList.remove('is-hidden');
      el.classList.toggle('is-veiled', y > half && !el.classList.contains('is-hidden'));
      last = y;
    });
    el.addEventListener('focusin', function () { el.classList.remove('is-hidden'); });
  })();

  /* ---------- anteprime (immagini generate quando si avvicinano) ---------- */
  var SIZE = { desktop: 480, phone: 200, poster: 360, feature: 360 };
  // una anteprima alla volta, nei momenti liberi: il thread principale non si blocca mai a lungo
  var queue = [], busy = false;
  var idle = window.requestIdleCallback || function (f) { return setTimeout(f, 40); };
  function pump() {
    if (busy || !queue.length) return;
    busy = true;
    idle(function () {
      var img = queue.shift();
      var s = sectorById(img.getAttribute('data-mock'));
      var kind = img.getAttribute('data-kind') || (img.closest('.shot') ? 'feature' : 'poster');
      var done = function () { busy = false; pump(); };
      if (!s) { done(); return; }
      var size = +img.getAttribute('data-size') || SIZE[kind] || 360;
      N.mockups.mockupURL(s, kind, size, 0).then(function (url) {
        img.onload = function () { img.classList.add('is-loaded'); };
        img.src = url;
        done();
      }, done);
    }, { timeout: 1000 });
  }
  function hydrate(img) { queue.push(img); pump(); }
  var mockIO = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) { if (e.isIntersecting) { mockIO.unobserve(e.target); hydrate(e.target); } });
  }, { rootMargin: '700px 0px' });
  $$('img[data-mock]').forEach(function (img) { mockIO.observe(img); });

  /* ---------- hero: parole che entrano, anteprime che fluttuano e seguono il mouse ---------- */
  (function hero() {
    var section = $('.hero');
    if (!section) return;
    $$('.hero__title .word').forEach(function (w, i) { w.style.setProperty('--i', i); });
    requestAnimationFrame(function () { section.classList.add('is-in'); });
    var layer = $('.hero__shots');
    var shots = $$('.hshot', layer);
    var mx = 0, my = 0, cx = 0, cy = 0, raf = 0, scrollY0 = 0;
    function render() {
      raf = 0;
      cx += (mx - cx) * 0.08; cy += (my - cy) * 0.08;
      shots.forEach(function (s) {
        var d = parseFloat(s.getAttribute('data-depth'));
        s.style.setProperty('--px', (cx * 38 * d).toFixed(2) + 'px');
        s.style.setProperty('--py', (cy * 26 * d - scrollY0 * 0.35 * d).toFixed(2) + 'px');
      });
      if (Math.abs(mx - cx) > 0.001 || Math.abs(my - cy) > 0.001) raf = requestAnimationFrame(render);
    }
    function kick() { if (!raf) raf = requestAnimationFrame(render); }
    if (finePointer && !reduced) {
      section.addEventListener('pointermove', function (e) {
        mx = e.clientX / innerWidth * 2 - 1; my = e.clientY / innerHeight * 2 - 1; kick();
      }, { passive: true });
    }
    if (!reduced) {
      scrollers.push(function (y) { if (y < innerHeight * 1.2) { scrollY0 = y; kick(); } });
    }
    // le anteprime dell'hero si generano dopo il primo disegno, una alla volta
    $$('img', layer).forEach(function (img) { mockIO.unobserve(img); hydrate(img); });
  })();

  /* ---------- comparsa allo scroll ---------- */
  (function reveal() {
    var els = $$('[data-reveal]');
    if (reduced || !('IntersectionObserver' in window)) { els.forEach(function (e) { e.classList.add('is-in'); }); return; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); } });
    }, { threshold: 0.2, rootMargin: '0px 0px -8% 0px' });
    els.forEach(function (e, i) { e.style.setProperty('--d', (i % 5) * 0.06 + 's'); io.observe(e); });
  })();

  /* ---------- portfolio: slider orizzontale, trascinabile, con dettagli al clic ---------- */
  (function work() {
    var track = $('.work__track');
    if (!track) return;
    var cards = $$('.pcard', track), arrows = $$('.work__arrow');
    var smooth = reduced ? 'auto' : 'smooth';
    function stepW() { return cards[0].offsetWidth + (parseFloat(getComputedStyle(track).columnGap) || 16); }
    function updateArrows() {
      if (arrows.length < 2) return;
      arrows[0].disabled = track.scrollLeft <= 2;
      arrows[1].disabled = track.scrollLeft >= track.scrollWidth - track.clientWidth - 2;
    }
    arrows.forEach(function (a) {
      a.addEventListener('click', function () { track.scrollBy({ left: stepW() * +a.getAttribute('data-dir'), behavior: smooth }); });
    });
    track.addEventListener('scroll', updateArrows, { passive: true });
    addEventListener('resize', updateArrows);
    updateArrows();

    // trascinamento col mouse (al tocco basta lo scroll nativo)
    var down = false, moved = false, x0 = 0, s0 = 0;
    track.addEventListener('pointerdown', function (e) {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      down = true; moved = false; x0 = e.clientX; s0 = track.scrollLeft;
    });
    addEventListener('pointermove', function (e) {
      if (!down) return;
      var dx = e.clientX - x0;
      if (!moved && Math.abs(dx) > 6) { moved = true; track.classList.add('is-dragging'); }
      if (moved) track.scrollLeft = s0 - dx;
    });
    addEventListener('pointerup', function () {
      if (!down) return;
      down = false;
      if (!moved) return;
      var w = stepW(), target = Math.round(track.scrollLeft / w) * w;
      track.classList.remove('is-dragging');
      track.scrollTo({ left: target, behavior: smooth });
    });
    // un trascinamento non apre la scheda
    track.addEventListener('click', function (e) {
      if (moved) { e.preventDefault(); e.stopPropagation(); moved = false; }
    }, true);

    function closeAll() {
      cards.forEach(function (c) { c.classList.remove('is-open'); $('.pcard__face', c).setAttribute('aria-expanded', 'false'); });
    }
    cards.forEach(function (c) {
      var face = $('.pcard__face', c), detail = $('.pcard__detail', c);
      face.addEventListener('click', function () {
        var open = !c.classList.contains('is-open');
        closeAll();
        c.classList.toggle('is-open', open);
        face.setAttribute('aria-expanded', String(open));
      });
      detail.addEventListener('click', function (e) { if (!e.target.closest('.pill')) { closeAll(); face.focus(); } });
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeAll(); });
  })();

  /* ---------- per chi lavoriamo: tab (desktop) e slider con pallini (mobile) ---------- */
  (function who() {
    var tabs = $$('.who__tab'), panels = $$('.who__panel'), dots = $$('.who__dots i');
    if (!tabs.length) return;
    function select(i, focus) {
      tabs.forEach(function (t, j) {
        var on = i === j;
        t.classList.toggle('is-active', on);
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
      });
      panels.forEach(function (p, j) { p.classList.toggle('is-active', i === j); });
      if (focus) tabs[i].focus();
    }
    tabs.forEach(function (t, i) {
      t.addEventListener('click', function () { select(i); });
      if (finePointer) t.addEventListener('pointerenter', function () { select(i); });
      t.addEventListener('keydown', function (e) {
        var n = tabs.length, j = null;
        if (e.key === 'ArrowDown' || e.key === 'ArrowRight') j = (i + 1) % n;
        else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') j = (i - 1 + n) % n;
        else if (e.key === 'Home') j = 0;
        else if (e.key === 'End') j = n - 1;
        if (j !== null) { e.preventDefault(); select(j, true); }
      });
    });
    // su mobile i pallini seguono la scheda visibile
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        var i = panels.indexOf(e.target);
        dots.forEach(function (d, j) { d.classList.toggle('is-active', i === j); });
      });
    }, { root: $('.who__panels'), threshold: 0.6 });
    panels.forEach(function (p) { io.observe(p); });
  })();

  /* ---------- prezzi: su mobile le due card scorrono di lato, i pallini seguono ---------- */
  (function plans() {
    var grid = $('.plans__grid');
    if (!grid) return;
    var cards = $$('.plan', grid), dots = $$('.plans__dots i');
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        var i = cards.indexOf(e.target);
        dots.forEach(function (d, j) { d.classList.toggle('is-active', i === j); });
      });
    }, { root: grid, threshold: 0.6 });
    cards.forEach(function (c) { io.observe(c); });
  })();

  /* ---------- contatto: modale Bootstrap che apre WhatsApp con il messaggio pronto ---------- */
  (function contact() {
    var el = $('#contact');
    if (!el) return;
    var form = $('#contactForm'), msg = $('#cMsg');
    var modal = null, autoMsg = '';
    function getModal() { return modal || (window.bootstrap ? (modal = bootstrap.Modal.getOrCreateInstance(el)) : null); }
    document.addEventListener('click', function (e) {
      var t = e.target.closest('[data-contact]');
      if (!t) return;
      e.preventDefault();
      var topic = t.getAttribute('data-contact');
      // il testo precompilato segue l'ultimo pulsante cliccato; se il cliente ha scritto qualcosa di suo, non lo tocchiamo
      if (topic && (!msg.value.trim() || msg.value === autoMsg)) {
        autoMsg = /^Piano /.test(topic) ? 'Mi interessa il ' + topic + '.' : 'Mi interessa un sito come il concept "' + topic + '".';
        msg.value = autoMsg;
      }
      var m = getModal();
      if (m) m.show();
      else window.open('https://wa.me/' + WA_NUMBER, '_blank', 'noopener');
    });
    // promo «Porta un amico»: il link dell'amico (?amico=CODICE) precompila il codice
    var amico = $('#cAmico'), refCode = '';
    try {
      refCode = (new URLSearchParams(location.search).get('amico') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
      if (refCode) sessionStorage.setItem('noifla_amico', refCode);
      else refCode = sessionStorage.getItem('noifla_amico') || '';
    } catch (err) { /* senza storage il codice vale solo per questa pagina */ }
    if (amico && refCode) amico.value = refCode;
    el.addEventListener('shown.bs.modal', function () { $('#cNome').focus(); });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!form.checkValidity()) {
        form.classList.add('was-validated');
        var bad = form.querySelector(':invalid'); if (bad) bad.focus();
        return;
      }
      var v = function (id) { return $(id).value.trim(); };
      var code = amico ? amico.value.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
      var testo = 'Ciao Noifla! Sono ' + v('#cNome') + '. Vorrei un preventivo e la prima bozza del sito. Recapito: ' + v('#cContatto') + '. ' +
        (code ? 'Codice amico: ' + code + '. ' : '') + v('#cMsg');
      window.open('https://wa.me/' + WA_NUMBER + '?text=' + encodeURIComponent(testo), '_blank', 'noopener');
      form.reset(); form.classList.remove('was-validated');
      if (amico && refCode) amico.value = refCode;
      var m = getModal(); if (m) m.hide();
    });
  })();


  requestScrollFrame();
})();
