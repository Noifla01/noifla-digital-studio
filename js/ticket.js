/* Noifla Digital Studio — area clienti (ticket con link personale).
   Nessuna libreria: due chiamate alle funzioni del database (client_portal e
   client_portal_create_ticket) con la chiave anon. Il database restituisce solo
   i dati del cliente a cui appartiene il codice nel link. */
(function () {
  'use strict';

  var cfg = window.NOIFLA_SUPABASE || {};
  var $ = function (s) { return document.querySelector(s); };
  var token = new URLSearchParams(location.search).get('t') || '';

  var STATUS = { aperto: ['Ricevuta', 'info'], in_lavorazione: ['In lavorazione', 'warn'], completato: ['Completata', 'ok'], rifiutato_extra: ['Da preventivare', 'muted'] };
  var CAT = { modifica_inclusa: 'Modifica inclusa', extra_preventivo: 'Extra / preventivo', bug_assistenza: 'Assistenza' };
  var df = new Intl.DateTimeFormat('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' });
  var data = null;

  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function badge(text, tone) { return el('span', 'adm-badge adm-badge--' + tone, text); }
  function toast(msg) { var t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(function () { t.hidden = true; }, 3500); }

  function rpc(fn, args) {
    return fetch(cfg.supabaseUrl.replace(/\/$/, '') + '/rest/v1/rpc/' + fn, {
      method: 'POST',
      headers: { apikey: cfg.supabaseAnonKey, Authorization: 'Bearer ' + cfg.supabaseAnonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(args)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        if (!r.ok) { var e = new Error(body.message || 'Errore ' + r.status); e.invalid = /link non valido/.test(body.message || ''); throw e; }
        return body;
      });
    });
  }

  function invalid() { $('#tkLoading').hidden = true; $('#tkApp').hidden = true; $('#tkInvalid').hidden = false; }

  function render(d) {
    data = d;
    $('#tkLoading').hidden = true;
    $('#tkApp').hidden = false;
    $('#tkName').textContent = d.business_name;
    document.title = d.business_name + ' · Area clienti';
    var b = $('#tkBadges'); b.textContent = '';
    b.appendChild(badge(d.plan === 'piano_completo' ? 'Piano Completo' : 'Piano Base', 'info'));
    if (d.plan === 'piano_completo') {
      var used = d.changes_used, q = d.changes_quota;
      b.appendChild(badge('Modifiche incluse questo mese: ' + used + '/' + q, used >= q ? 'bad' : used === q - 1 ? 'warn' : 'ok'));
    } else {
      b.appendChild(badge('Modifiche a parte: 20€/ora', 'muted'));
    }
    $('#tkForm').hidden = !d.can_open;
    $('#tkClosed').hidden = d.can_open;
    updateQuotaNote();

    var list = $('#tkList'); list.textContent = '';
    if (!d.tickets.length) list.appendChild(el('li', 'adm-muted', 'Non hai ancora inviato richieste.'));
    d.tickets.forEach(function (t) {
      var st = STATUS[t.status] || [t.status, 'muted'];
      var li = el('li', 'adm-log__item');
      var meta = el('div', 'adm-log__meta');
      meta.appendChild(el('time', null, df.format(new Date(t.created_at))));
      meta.appendChild(badge(CAT[t.category] || t.category, 'muted'));
      if (t.closed_at) meta.appendChild(el('span', null, 'chiusa il ' + df.format(new Date(t.closed_at))));
      var row = el('div', 'adm-log__row');
      var txt = el('div');
      txt.appendChild(el('strong', null, t.title));
      if (t.description) txt.appendChild(el('p', 'adm-pre adm-muted', t.description));
      row.appendChild(txt);
      row.appendChild(badge(st[0], st[1]));
      li.appendChild(meta); li.appendChild(row);
      list.appendChild(li);
    });
  }

  // avviso sotto la scelta del tipo: cosa succede a questa richiesta
  function updateQuotaNote() {
    var n = $('#tkQuotaNote'), kind = (document.querySelector('input[name="kind"]:checked') || {}).value;
    var msg = '';
    if (data && kind === 'modifica') {
      if (data.plan !== 'piano_completo') msg = 'Con il Piano Base le modifiche si pagano a parte, 20€/ora.';
      else if (data.changes_used >= data.changes_quota) msg = 'Hai già usato le ' + data.changes_quota + ' modifiche incluse questo mese: questa verrà valutata come extra, ti avvisiamo prima di procedere.';
    }
    if (kind === 'nuova_funzionalita') msg = 'Le nuove funzionalità non sono incluse nel piano: ti mandiamo un preventivo prima di iniziare.';
    n.textContent = msg; n.hidden = !msg;
  }
  Array.prototype.forEach.call(document.querySelectorAll('input[name="kind"]'), function (r) { r.addEventListener('change', updateQuotaNote); });

  function formError(msg) { var e = $('#tkError'); e.textContent = msg || ''; e.hidden = !msg; }
  $('#tkForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    formError('');
    var title = $('#tkTitle').value.trim();
    if (title.length < 3) { formError('Scrivi un titolo di almeno 3 caratteri.'); $('#tkTitle').focus(); return; }
    var btn = $('#tkSubmit'); btn.disabled = true;
    rpc('client_portal_create_ticket', {
      p_token: token,
      p_kind: document.querySelector('input[name="kind"]:checked').value,
      p_title: title,
      p_description: $('#tkDesc').value.trim()
    }).then(function (d) {
      $('#tkTitle').value = ''; $('#tkDesc').value = '';
      render(d);
      toast('Richiesta inviata. Grazie!');
    }, function (e) {
      if (e.invalid) invalid(); else formError(e.message);
    }).then(function () { btn.disabled = false; });
  });

  var configured = cfg.supabaseUrl && cfg.supabaseAnonKey && !/TUO-PROGETTO|INCOLLA/.test(cfg.supabaseUrl + cfg.supabaseAnonKey);
  if (!configured || !/^[0-9a-f]{64}$/.test(token)) { invalid(); return; }
  rpc('client_portal', { p_token: token }).then(render, function (e) {
    if (e.invalid) invalid();
    else { $('#tkLoading').textContent = 'Non riusciamo a caricare la pagina in questo momento. Riprova tra poco.'; }
  });
})();
