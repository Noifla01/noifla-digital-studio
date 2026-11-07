/* ===== Noifla Digital Studio: logica interattiva ===== */
(() => {
  'use strict';

  const CONSENT_KEY = 'noifla_cookie_consent';
  const WA_NUMBER = '390000000000'; // TODO: sostituire con il numero WhatsApp reale (formato internazionale, senza +)
  const $ = (s) => document.querySelector(s);
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- Cookie GDPR + Google Consent Mode ---------- */
  window.dataLayer = window.dataLayer || [];
  function gtag() { dataLayer.push(arguments); }
  // Tutto negato finché l'utente non sceglie (compatibile con GTM e Cookiebot)
  gtag('consent', 'default', { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', analytics_storage: 'denied', wait_for_update: 500 });

  const banner = $('#cookieBanner'), panel = $('#cookiePanel'), analyticsBox = $('#cookieAnalytics');
  const btn = { accept: $('#cookieAccept'), reject: $('#cookieReject'), custom: $('#cookieCustomize'), save: $('#cookieSave') };

  const readConsent = () => {
    try { const v = JSON.parse(localStorage.getItem(CONSENT_KEY)); if (v) return v; } catch (e) {}
    const m = document.cookie.match(/(?:^|; )noifla_consent=([^;]*)/); // fallback se localStorage non è disponibile
    try { return m ? JSON.parse(decodeURIComponent(m[1])) : null; } catch (e) { return null; }
  };
  const saveConsent = (analytics) => {
    const c = { necessary: true, analytics: !!analytics, ts: Date.now() };
    try { localStorage.setItem(CONSENT_KEY, JSON.stringify(c)); } catch (e) {}
    document.cookie = `noifla_consent=${encodeURIComponent(JSON.stringify(c))}; max-age=15552000; path=/; SameSite=Lax`;
    applyConsent(c); hideBanner();
  };
  const applyConsent = (c) => {
    gtag('consent', 'update', { analytics_storage: c.analytics ? 'granted' : 'denied' });
    if (c.analytics) loadAnalytics();
  };
  // Punto di integrazione: carica qui Google Tag Manager / Analytics / Cookiebot, solo dopo il consenso.
  let analyticsLoaded = false;
  function loadAnalytics() {
    if (analyticsLoaded) return; analyticsLoaded = true;
    // Esempio GTM: const s = document.createElement('script'); s.async = true;
    // s.src = 'https://www.googletagmanager.com/gtm.js?id=GTM-XXXXXXX'; document.head.appendChild(s);
  }

  const showBanner = () => { banner.hidden = false; requestAnimationFrame(() => banner.classList.add('show')); };
  const hideBanner = () => { banner.classList.remove('show'); setTimeout(() => (banner.hidden = true), 400); };

  btn.accept.addEventListener('click', () => saveConsent(true));
  btn.reject.addEventListener('click', () => saveConsent(false));
  btn.save.addEventListener('click', () => saveConsent(analyticsBox.checked));
  btn.custom.addEventListener('click', () => {
    const open = panel.hidden; panel.hidden = !open; btn.save.hidden = !open;
    btn.custom.setAttribute('aria-expanded', String(open));
  });
  $('#cookiePrefs').addEventListener('click', () => { analyticsBox.checked = !!(readConsent() || {}).analytics; showBanner(); });

  const stored = readConsent();
  stored ? applyConsent(stored) : showBanner();

  /* ---------- Navbar: stato allo scroll e chiusura menu mobile ---------- */
  const nav = $('#nav');
  const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 10);
  onScroll(); addEventListener('scroll', onScroll, { passive: true });

  /* ---------- Smooth scroll sugli ancoraggi ---------- */
  document.querySelectorAll('a[href^="#"]').forEach((a) => a.addEventListener('click', (e) => {
    const id = a.getAttribute('href');
    const target = id.length > 1 && document.querySelector(id);
    if (id !== '#' && !target) return;
    e.preventDefault();
    (target || document.body).scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' });
    history.pushState(null, '', id === '#' ? location.pathname : id);
    const menu = $('#menu'); if (menu.classList.contains('show')) bootstrap.Collapse.getOrCreateInstance(menu).hide();
  }));

  /* ---------- Comparsa delle sezioni ---------- */
  const targets = document.querySelectorAll('.section .glass, .section-title');
  if ('IntersectionObserver' in window && !reduceMotion) {
    const io = new IntersectionObserver((entries) => entries.forEach((en) => {
      if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
    }), { threshold: .15 });
    targets.forEach((el) => { el.classList.add('reveal'); io.observe(el); });
  }

  /* ---------- Modulo contatto: apre WhatsApp con il messaggio precompilato ---------- */
  const form = $('#contactForm');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!form.checkValidity()) { form.classList.add('was-validated'); return; }
    const testo = `Ciao Noifla! Sono ${$('#cNome').value.trim()}. Vorrei la bozza gratuita del sito. Recapito: ${$('#cContatto').value.trim()}. ${$('#cMsg').value.trim()}`;
    window.open(`https://wa.me/${WA_NUMBER}?text=${encodeURIComponent(testo)}`, '_blank', 'noopener');
    bootstrap.Modal.getInstance($('#contattoModal')).hide();
    form.reset(); form.classList.remove('was-validated');
  });
  /* ---------- Profondità 3D: inclinazione del mockup e luce che segue il cursore ---------- */
  if (matchMedia('(hover: hover) and (pointer: fine)').matches && !reduceMotion) {
    const scene = $('.scene'), dev = $('#device');
    scene.addEventListener('pointermove', (e) => {
      const r = scene.getBoundingClientRect();
      dev.style.setProperty('--ry', ((e.clientX - r.left) / r.width - .5) * 10 + 'deg');
      dev.style.setProperty('--rx', ((e.clientY - r.top) / r.height - .5) * -8 + 'deg');
    });
    scene.addEventListener('pointerleave', () => { dev.style.setProperty('--ry', '0deg'); dev.style.setProperty('--rx', '0deg'); });
    document.addEventListener('pointermove', (e) => {
      const c = e.target.closest && e.target.closest('.card-glass, .price-card');
      if (!c) return;
      const r = c.getBoundingClientRect();
      c.style.setProperty('--mx', (e.clientX - r.left) + 'px'); c.style.setProperty('--my', (e.clientY - r.top) + 'px');
    }, { passive: true });
  }
})();