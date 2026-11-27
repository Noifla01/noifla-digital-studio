/* Noifla Digital Studio — anti-clickjacking per gestionale e area clienti.
   GitHub Pages non permette l'header "frame-ancestors": se la pagina viene caricata
   dentro un altro sito la nascondiamo e proviamo a riaprirla a pagina intera.
   Va caricato nel <head>, prima di tutto il resto. */
(function () {
  if (window.self === window.top) return;
  document.documentElement.style.display = 'none';
  try { window.top.location.replace(window.self.location.href); } catch (e) { /* bloccato dal sito esterno: la pagina resta nascosta */ }
})();
