/* Noifla Digital Studio — gestionale (JavaScript vanilla + Bootstrap + supabase-js).
   I permessi stanno nel database (RLS): questa pagina mostra solo ciò che l'utente può leggere.
   Tutto il testo inserito da clienti e admin viene scritto con textContent, mai come HTML. */
(function () {
  'use strict';

  var cfg = window.NOIFLA_SUPABASE || {};
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var LABEL = {
    plan: { piano_completo: 'Completo', piano_base: 'Base' },
    sub: { attivo: 'Attivo', in_rinnovo: 'In rinnovo', scaduto: 'Scaduto' },
    pay: { pagato: 'Pagato', fallito: 'Fallito', in_attesa: 'In attesa' },
    cat: { modifica_inclusa: 'Modifica inclusa', extra_preventivo: 'Extra / preventivo', bug_assistenza: 'Bug / assistenza' },
    status: { aperto: 'Aperto', in_lavorazione: 'In lavorazione', completato: 'Completato', rifiutato_extra: 'Rifiutato / extra' },
    note: { intervista: 'Intervista iniziale', accordo: 'Accordo', specifica: 'Specifica', altro: 'Altro' }
  };
  var TONE = {
    sub: { attivo: 'ok', in_rinnovo: 'bad', scaduto: 'muted' },
    pay: { pagato: 'ok', fallito: 'bad', in_attesa: 'warn' },
    status: { aperto: 'info', in_lavorazione: 'warn', completato: 'ok', rifiutato_extra: 'muted' }
  };

  /* ---------- utilità ---------- */
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'text') n.textContent = attrs[k];
      else if (k === 'class') n.className = attrs[k];
      else if (attrs[k] != null && attrs[k] !== false) n.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c != null) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function badge(text, tone) { return el('span', { class: 'adm-badge adm-badge--' + (tone || 'muted'), text: text }); }
  var dfDate = new Intl.DateTimeFormat('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Rome' });
  var dfTime = new Intl.DateTimeFormat('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' });
  function fmtDate(v) { return v ? dfDate.format(new Date(v)) : '–'; }
  function fmtTime(v) { return v ? dfTime.format(new Date(v)) : '–'; }
  function euro(v) { return v == null ? '–' : Number(v).toLocaleString('it-IT', { style: 'currency', currency: 'EUR' }); }
  function toast(msg, bad) {
    var t = $('#toast');
    t.textContent = msg; t.hidden = false; t.classList.toggle('is-bad', !!bad);
    clearTimeout(toast.t); toast.t = setTimeout(function () { t.hidden = true; }, 3500);
  }
  function errText(e) { return (e && (e.message || e.error_description)) || 'Errore imprevisto'; }
  function show(id) { ['#viewConfig', '#viewLogin', '#viewApp'].forEach(function (v) { $(v).hidden = v !== id; }); }

  /* ---------- avvio ---------- */
  var configured = cfg.supabaseUrl && cfg.supabaseAnonKey && !/TUO-PROGETTO|INCOLLA/.test(cfg.supabaseUrl + cfg.supabaseAnonKey);
  if (!configured || !window.supabase) { show('#viewConfig'); return; }
  var sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true } });

  var state = { clients: [], tickets: [], current: null, view: 'clients' };
  var drawer = null;

  async function boot() {
    var res = await sb.auth.getSession();
    var session = res.data && res.data.session;
    if (!session) { show('#viewLogin'); $('#lEmail').focus(); return; }
    var adm = await sb.rpc('is_admin');
    if (adm.error || adm.data !== true) {
      await sb.auth.signOut();
      show('#viewLogin');
      loginError('Questo account non è autorizzato al gestionale.');
      return;
    }
    $('#userEmail').textContent = session.user.email || '';
    show('#viewApp');
    await refreshAll();
  }

  /* ---------- login / logout ---------- */
  function loginError(msg) { var e = $('#loginError'); e.textContent = msg || ''; e.hidden = !msg; }
  $('#loginForm').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    loginError('');
    var btn = $('#loginBtn'); btn.disabled = true;
    var r = await sb.auth.signInWithPassword({ email: $('#lEmail').value.trim(), password: $('#lPass').value });
    btn.disabled = false;
    if (r.error) { loginError('Email o password non corretti.'); return; }
    $('#lPass').value = '';
    boot();
  });
  $('#logoutBtn').addEventListener('click', async function () { await sb.auth.signOut(); location.reload(); });

  /* ---------- dati ---------- */
  async function loadClients() {
    var r = await sb.from('client_overview').select('*').order('business_name', { ascending: true });
    if (r.error) throw r.error;
    state.clients = r.data || [];
  }
  async function loadTickets() {
    var r = await sb.from('tickets').select('*').order('created_at', { ascending: false }).limit(1000);
    if (r.error) throw r.error;
    state.tickets = r.data || [];
  }
  // pagamenti Stripe arrivati per un customer non ancora inserito in nessuna scheda cliente
  async function loadOrphans() {
    var r = await sb.from('payments').select('stripe_customer_id, amount_cents, created_at').is('client_id', null)
      .order('created_at', { ascending: false }).limit(50);
    if (r.error) throw r.error;
    state.orphans = r.data || [];
  }
  function renderOrphans() {
    var box = $('#orphanBox'), list = state.orphans || [];
    box.hidden = !list.length;
    if (!list.length) return;
    var ids = list.map(function (p) { return p.stripe_customer_id; }).filter(function (v, i, a) { return v && a.indexOf(v) === i; });
    box.textContent = list.length + (list.length === 1 ? ' pagamento Stripe non è collegato' : ' pagamenti Stripe non sono collegati') +
      ' a nessun cliente (customer: ' + (ids.join(', ') || '–') + '). Inserisci il customer ID nella scheda del cliente: verranno collegati e conteggiati.';
  }
  async function refreshAll() {
    try { await Promise.all([loadClients(), loadTickets(), loadOrphans()]); }
    catch (e) { toast('Impossibile caricare i dati: ' + errText(e), true); return; }
    renderStats(); renderOrphans(); renderClients(); renderTicketFilters(); renderTickets();
    if (state.current) {
      var fresh = clientById(state.current.id);
      if (fresh) { state.current = fresh; renderDrawerHead(); }
    }
  }
  function clientById(id) { return state.clients.filter(function (c) { return c.id === id; })[0]; }

  /* ---------- riepilogo ---------- */
  function needsAttention(c) {
    return c.subscription_status === 'in_rinnovo' || c.last_payment_status === 'fallito' ||
      c.loyalty_state === 'in_arrivo' || c.loyalty_state === 'da_applicare' ||
      (c.changes_quota > 0 && c.changes_used_this_month >= c.changes_quota);
  }
  function renderStats() {
    var cs = state.clients;
    $('#stActive').textContent = cs.filter(function (c) { return c.subscription_status === 'attivo'; }).length;
    $('#stFailed').textContent = cs.filter(function (c) { return c.subscription_status === 'in_rinnovo' || c.last_payment_status === 'fallito'; }).length;
    $('#stLoyalty').textContent = cs.filter(function (c) { return c.loyalty_state === 'in_arrivo' || c.loyalty_state === 'da_applicare'; }).length;
    $('#stTickets').textContent = state.tickets.filter(function (t) { return t.status === 'aperto' || t.status === 'in_lavorazione'; }).length;
  }

  /* ---------- badge ricorrenti ---------- */
  function loyaltyBadge(c) {
    if (c.loyalty_state === 'da_applicare') return badge('36 mesi raggiunti: riduci a ' + euro(c.loyalty_rate), 'warn-strong');
    if (c.loyalty_state === 'in_arrivo') return badge('Mancano ' + c.months_to_loyalty + (c.months_to_loyalty === 1 ? ' rata' : ' rate') + ' ai 36 mesi', 'warn');
    if (c.loyalty_state === 'applicata') return badge('Tariffa fedeltà applicata', 'ok');
    return null;
  }
  // da quando si contano le modifiche: dall'ultimo pagamento, o dal mese solare se non paga con Stripe
  function quotaPeriod(c) {
    return c.changes_period_kind === 'pagamento' ? 'dal pagamento del ' + fmtDate(c.changes_period_start) : 'questo mese';
  }
  function quotaBadge(c) {
    if (c.plan !== 'piano_completo') return badge('A pagamento (20€/ora)', 'muted');
    var used = c.changes_used_this_month, q = c.changes_quota;
    var tone = used >= q ? 'bad' : used === q - 1 ? 'warn' : 'ok';
    return badge(used + '/' + q + ' modifiche' + (used >= q ? ': esaurite' : ''), tone);
  }

  /* ---------- tabella clienti ---------- */
  function renderClients() {
    var q = $('#clientSearch').value.trim().toLowerCase();
    var f = $('#clientFilter').value;
    var rows = state.clients.filter(function (c) {
      if (f === 'attention' && !needsAttention(c)) return false;
      if (['attivo', 'in_rinnovo', 'scaduto'].indexOf(f) >= 0 && c.subscription_status !== f) return false;
      if (!q) return true;
      return [c.business_name, c.contact_name, c.email, c.phone, c.site_url].join(' ').toLowerCase().indexOf(q) >= 0;
    });
    var body = $('#clientRows');
    body.textContent = '';
    rows.forEach(function (c) {
      var name = el('button', { class: 'adm-link', type: 'button', text: c.business_name });
      name.addEventListener('click', function () { openClient(c.id); });
      var sub = c.contact_name ? el('span', { class: 'adm-sub-line', text: c.contact_name }) : null;
      var months = el('td', null, [el('span', { class: 'adm-num', text: String(c.paid_months_count) }), ' ', loyaltyBadge(c)]);
      body.appendChild(el('tr', { class: needsAttention(c) ? 'is-attention' : null }, [
        el('td', null, [name, sub]),
        el('td', null, [LABEL.plan[c.plan] + ' · ' + euro(c.monthly_rate)]),
        el('td', null, [badge(LABEL.sub[c.subscription_status], TONE.sub[c.subscription_status])]),
        el('td', null, [c.last_payment_status ? badge(LABEL.pay[c.last_payment_status], TONE.pay[c.last_payment_status]) : el('span', { class: 'adm-muted', text: '–' }),
          c.last_payment_at ? el('span', { class: 'adm-sub-line', text: fmtDate(c.last_payment_at) }) : null]),
        months,
        el('td', null, [quotaBadge(c)]),
        el('td', null, [c.open_tickets ? badge(String(c.open_tickets), 'info') : el('span', { class: 'adm-muted', text: '0' })])
      ]));
    });
    $('#clientEmpty').hidden = rows.length > 0;
  }
  $('#clientSearch').addEventListener('input', renderClients);
  $('#clientFilter').addEventListener('change', renderClients);

  /* ---------- tabella ticket ---------- */
  function renderTicketFilters() {
    var sel = $('#ticketClientFilter'), keep = sel.value;
    sel.textContent = '';
    sel.appendChild(el('option', { value: '', text: 'Tutti i clienti' }));
    state.clients.forEach(function (c) { sel.appendChild(el('option', { value: c.id, text: c.business_name })); });
    sel.value = keep;
  }
  // menu a tendina che salva subito un campo del ticket (stato o categoria)
  function ticketSelect(t, field) {
    var labels = field === 'status' ? LABEL.status : LABEL.cat;
    var s = el('select', { class: 'adm-input adm-input--auto adm-input--sm', 'aria-label': field === 'status' ? 'Stato del ticket' : 'Categoria del ticket' });
    Object.keys(labels).forEach(function (k) { s.appendChild(el('option', { value: k, text: labels[k] })); });
    s.value = t[field];
    if (field === 'status') s.dataset.tone = TONE.status[t.status];
    else if (t.category === 'modifica_inclusa') s.dataset.tone = 'info';
    s.addEventListener('change', async function () {
      s.disabled = true;
      var patch = {}; patch[field] = s.value;
      var r = await sb.from('tickets').update(patch).eq('id', t.id);
      s.disabled = false;
      if (r.error) { toast(errText(r.error), true); s.value = t[field]; return; }
      toast(field === 'status' ? 'Stato aggiornato' : 'Categoria aggiornata');
      await refreshAll();
      if (state.current) loadClientTickets();
    });
    return s;
  }
  function statusSelect(t) { return ticketSelect(t, 'status'); }
  function renderTickets() {
    var fs = $('#ticketStatusFilter').value, fc = $('#ticketClientFilter').value;
    var rows = state.tickets.filter(function (t) {
      if (fc && t.client_id !== fc) return false;
      if (fs === 'open') return t.status === 'aperto' || t.status === 'in_lavorazione';
      return fs === 'all' || t.status === fs;
    });
    var body = $('#ticketRows');
    body.textContent = '';
    rows.forEach(function (t) {
      var c = clientById(t.client_id);
      var cl = el('button', { class: 'adm-link', type: 'button', text: c ? c.business_name : '–' });
      if (c) cl.addEventListener('click', function () { openClient(c.id, 'tickets'); });
      body.appendChild(el('tr', null, [
        el('td', { text: fmtTime(t.created_at) }),
        el('td', null, [cl]),
        el('td', null, [el('strong', { text: t.title }), t.description ? el('span', { class: 'adm-sub-line adm-pre', text: t.description }) : null,
          t.source === 'cliente' ? badge('dal cliente', 'info') : null]),
        el('td', null, [ticketSelect(t, 'category')]),
        el('td', null, [statusSelect(t)]),
        el('td', { text: fmtTime(t.closed_at) })
      ]));
    });
    $('#ticketEmpty').hidden = rows.length > 0;
  }
  $('#ticketStatusFilter').addEventListener('change', renderTickets);
  $('#ticketClientFilter').addEventListener('change', renderTickets);

  /* ---------- schede principali ---------- */
  $$('.adm-tabs [data-view]').forEach(function (b) {
    b.addEventListener('click', function () {
      state.view = b.dataset.view;
      $$('.adm-tabs [data-view]').forEach(function (x) { var on = x === b; x.classList.toggle('is-active', on); x.setAttribute('aria-selected', String(on)); });
      $('#paneClients').hidden = state.view !== 'clients';
      $('#paneTickets').hidden = state.view !== 'tickets';
    });
  });

  /* ---------- scheda cliente ---------- */
  function getDrawer() { return drawer || (drawer = bootstrap.Offcanvas.getOrCreateInstance($('#clientDrawer'))); }
  function setSub(name) {
    $$('.adm-subtabs [data-sub]').forEach(function (b) { var on = b.dataset.sub === name; b.classList.toggle('is-active', on); b.setAttribute('aria-selected', String(on)); });
    $$('#clientDrawer .adm-sub').forEach(function (p) { p.hidden = p.dataset.pane !== name; });
  }
  $$('.adm-subtabs [data-sub]').forEach(function (b) { b.addEventListener('click', function () { setSub(b.dataset.sub); }); });

  function fillForm(c) {
    var f = $('#clientForm');
    ['business_name', 'contact_name', 'phone', 'email', 'site_url', 'plan', 'monthly_rate', 'contract_start_date',
      'paid_months_count', 'subscription_status', 'stripe_customer_id', 'stripe_subscription_id'].forEach(function (k) {
      var v = c ? c[k] : null;
      if (!c && k === 'plan') v = 'piano_completo';
      if (!c && k === 'subscription_status') v = 'attivo';
      if (!c && k === 'paid_months_count') v = 0;
      f.elements[k].value = v == null ? '' : v;
    });
    clientError('');
    $('#tokenBox').hidden = true;
    $('#tokenBtn').hidden = !c;
    $('#tokenBtn').textContent = c && c.ticket_token_created_at ? 'Rigenera link ticket' : 'Genera link ticket';
  }
  function renderDrawerHead() {
    var c = state.current;
    $('#drawerTitle').textContent = c ? c.business_name : 'Nuovo cliente';
    var b = $('#drawerBadges'); b.textContent = '';
    var box = $('#loyaltyBox'); box.hidden = true; box.textContent = '';
    $$('.adm-subtabs [data-sub]').forEach(function (x) { x.disabled = !c && x.dataset.sub !== 'data'; });
    if (!c) return;
    b.appendChild(badge(LABEL.plan[c.plan] + ' · ' + euro(c.monthly_rate), 'info'));
    b.appendChild(badge(LABEL.sub[c.subscription_status], TONE.sub[c.subscription_status]));
    if (c.last_payment_status) b.appendChild(badge('Ultimo pagamento: ' + LABEL.pay[c.last_payment_status], TONE.pay[c.last_payment_status]));
    b.appendChild(badge(c.paid_months_count + ' mensilità pagate', 'muted'));
    b.appendChild(quotaBadge(c));
    if (c.loyalty_state === 'in_arrivo' || c.loyalty_state === 'da_applicare') {
      box.hidden = false;
      box.classList.toggle('adm-alert--strong', c.loyalty_state === 'da_applicare');
      var msg = c.loyalty_state === 'da_applicare'
        ? 'Ha completato ' + c.paid_months_count + ' mensilità: la tariffa può scendere da ' + euro(c.monthly_rate) + ' a ' + euro(c.loyalty_rate) + '.'
        : 'Mancano ' + c.months_to_loyalty + ' mensilità ai 36 mesi: poi la tariffa scende da ' + euro(c.monthly_rate) + ' a ' + euro(c.loyalty_rate) + '.';
      box.appendChild(el('p', { text: msg }));
      if (c.loyalty_state === 'da_applicare') {
        var btn = el('button', { class: 'pill pill--solid', type: 'button', text: 'Applica ' + euro(c.loyalty_rate) });
        btn.addEventListener('click', applyLoyalty);
        box.appendChild(btn);
      }
    }
  }

  async function openClient(id, sub) {
    state.current = id ? clientById(id) : null;
    fillForm(state.current);
    renderDrawerHead();
    setSub(sub || 'data');
    getDrawer().show();
    if (state.current) { loadNotes(); loadClientTickets(); loadPayments(); }
  }
  $('#newClientBtn').addEventListener('click', function () { openClient(null); });
  $('#clientDrawer').addEventListener('hidden.bs.offcanvas', function () { state.current = null; });

  function clientError(msg) { var e = $('#clientError'); e.textContent = msg || ''; e.hidden = !msg; }
  $('#clientForm').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var f = ev.target;
    if (!f.elements.business_name.value.trim()) { clientError('Il nome dell\'attività è obbligatorio.'); f.elements.business_name.focus(); return; }
    var data = {};
    ['business_name', 'contact_name', 'phone', 'email', 'site_url', 'plan', 'contract_start_date',
      'subscription_status', 'stripe_customer_id', 'stripe_subscription_id'].forEach(function (k) {
      var v = f.elements[k].value.trim(); data[k] = v === '' ? null : v;
    });
    var rate = f.elements.monthly_rate.value;
    if (rate !== '') data.monthly_rate = Number(rate);
    else if (!state.current) data.monthly_rate = null;
    var paid = f.elements.paid_months_count.value;
    data.paid_months_count = paid === '' ? 0 : parseInt(paid, 10);
    var btn = $('#clientSave'); btn.disabled = true;
    var r = state.current
      ? await sb.from('clients').update(data).eq('id', state.current.id).select('id').single()
      : await sb.from('clients').insert(data).select('id').single();
    btn.disabled = false;
    if (r.error) { clientError(errText(r.error)); return; }
    toast(state.current ? 'Cliente aggiornato' : 'Cliente creato');
    await refreshAll();
    if (!state.current) openClient(r.data.id);
  });

  /* link ticket */
  $('#tokenBtn').addEventListener('click', async function () {
    var c = state.current; if (!c) return;
    if (c.ticket_token_created_at && !confirm('Il link attuale smetterà di funzionare. Continuare?')) return;
    var r = await sb.rpc('rotate_ticket_token', { p_client_id: c.id });
    if (r.error) { toast(errText(r.error), true); return; }
    $('#tokenUrl').value = new URL('ticket.html?t=' + encodeURIComponent(r.data), location.href).href;
    $('#tokenBox').hidden = false;
    $('#tokenBtn').textContent = 'Rigenera link ticket';
    await refreshAll();
  });
  $('#tokenCopy').addEventListener('click', function () {
    var i = $('#tokenUrl'); i.select();
    (navigator.clipboard ? navigator.clipboard.writeText(i.value) : Promise.reject()).then(
      function () { toast('Link copiato'); },
      function () { document.execCommand('copy'); toast('Link copiato'); });
  });

  /* tariffa dopo 36 mesi */
  async function applyLoyalty() {
    var c = state.current; if (!c) return;
    var onStripe = !!c.stripe_subscription_id;
    if (!confirm('Applicare a ' + c.business_name + ' la tariffa di ' + euro(c.loyalty_rate) + ' al posto di ' + euro(c.monthly_rate) + '?\n\n' +
      (onStripe ? 'Il prezzo cambia anche su Stripe, dalla prossima fattura (nessun conguaglio).' : 'Il cliente non ha un abbonamento Stripe collegato: la tariffa cambia solo nel gestionale.'))) return;

    // funzione lato server: aggiorna Stripe e poi il database (passo 5 del README)
    var r = await sb.functions.invoke('apply-loyalty-price', { body: { client_id: c.id } });
    if (r.error) {
      var body = null;
      try { body = r.error.context && typeof r.error.context.json === 'function' ? await r.error.context.json() : null; } catch (e) { body = null; }
      var notDeployed = r.error.name === 'FunctionsFetchError' || (r.error.context && r.error.context.status === 404);
      if (!notDeployed) { toast((body && body.error) || errText(r.error), true); return; }
      // funzione non ancora pubblicata: si può registrare solo nel database
      if (!confirm('La funzione che aggiorna Stripe non è raggiungibile.\nRegistrare la nuova tariffa solo nel gestionale? Su Stripe andrà cambiata a mano.')) return;
      var d = await sb.rpc('apply_loyalty_rate', { p_client_id: c.id });
      if (d.error) { toast(errText(d.error), true); return; }
      toast('Tariffa registrata solo nel gestionale: ' + euro(d.data) + '. Aggiornala su Stripe.');
    } else {
      toast('Nuova tariffa ' + euro(r.data.rate) + (r.data.stripe === 'aggiornato' ? ': aggiornata anche su Stripe' : ': registrata nel gestionale'));
    }
    await refreshAll();
    fillForm(state.current);
    loadNotes();
  }

  /* registro note */
  async function loadNotes() {
    var c = state.current; if (!c) return;
    var r = await sb.from('client_notes').select('*').eq('client_id', c.id).order('created_at', { ascending: false });
    var list = $('#noteList'); list.textContent = '';
    if (r.error) { list.appendChild(el('li', { class: 'adm-error', text: errText(r.error) })); return; }
    if (!r.data.length) list.appendChild(el('li', { class: 'adm-muted', text: 'Nessuna nota. Annota qui l\'intervista iniziale e gli accordi presi.' }));
    r.data.forEach(function (n) {
      list.appendChild(el('li', { class: 'adm-log__item' }, [
        el('div', { class: 'adm-log__meta' }, [badge(LABEL.note[n.kind], n.kind === 'intervista' ? 'info' : 'muted'), el('time', { datetime: n.created_at, text: fmtTime(n.created_at) })]),
        el('p', { class: 'adm-pre', text: n.body })
      ]));
    });
  }
  $('#noteForm').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var body = $('#noteBody').value.trim();
    if (!body || !state.current) return;
    var r = await sb.from('client_notes').insert({ client_id: state.current.id, kind: $('#noteKind').value, body: body });
    if (r.error) { toast(errText(r.error), true); return; }
    $('#noteBody').value = '';
    toast('Nota aggiunta');
    loadNotes();
  });

  /* ticket del cliente */
  async function loadClientTickets() {
    var c = state.current; if (!c) return;
    var q = $('#quotaBox'); q.textContent = '';
    q.appendChild(el('span', { class: 'adm-muted', text: 'Modifiche ' + quotaPeriod(c) + ': ' }));
    q.appendChild(quotaBadge(c));
    if (c.plan === 'piano_completo' && c.changes_used_this_month >= c.changes_quota) {
      q.appendChild(el('span', { class: 'adm-hint', text: 'Plafond esaurito: le nuove modifiche sono extra fino al prossimo pagamento.' }));
    }
    var r = await sb.from('tickets').select('*').eq('client_id', c.id).order('created_at', { ascending: false });
    var list = $('#clientTicketList'); list.textContent = '';
    if (r.error) { list.appendChild(el('li', { class: 'adm-error', text: errText(r.error) })); return; }
    if (!r.data.length) list.appendChild(el('li', { class: 'adm-muted', text: 'Nessun ticket.' }));
    r.data.forEach(function (t) {
      list.appendChild(el('li', { class: 'adm-log__item' }, [
        el('div', { class: 'adm-log__meta' }, [
          el('time', { datetime: t.created_at, text: fmtTime(t.created_at) }),
          t.source === 'cliente' ? badge('dal cliente', 'info') : null,
          t.closed_at ? el('span', { class: 'adm-muted', text: 'chiuso il ' + fmtTime(t.closed_at) }) : null
        ]),
        el('div', { class: 'adm-log__row' }, [
          el('div', null, [el('strong', { text: t.title }), t.description ? el('p', { class: 'adm-pre adm-muted', text: t.description }) : null]),
          el('div', { class: 'adm-log__ctl' }, [ticketSelect(t, 'category'), statusSelect(t)])
        ])
      ]));
    });
  }
  $('#ticketForm').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var c = state.current, title = $('#tTitle').value.trim();
    if (!c || !title) { $('#tTitle').focus(); return; }
    var cat = $('#tCategory').value;
    if (cat === 'modifica_inclusa' && c.plan === 'piano_completo' && c.changes_used_this_month >= c.changes_quota &&
      !confirm('Il cliente ha già usato ' + c.changes_used_this_month + '/' + c.changes_quota + ' modifiche ' + quotaPeriod(c) + '. Registrarla comunque come inclusa?')) return;
    var r = await sb.from('tickets').insert({ client_id: c.id, title: title, description: $('#tDesc').value.trim() || null, category: cat, source: 'admin' });
    if (r.error) { toast(errText(r.error), true); return; }
    $('#tTitle').value = ''; $('#tDesc').value = '';
    toast('Ticket aperto');
    await refreshAll();
    loadClientTickets();
  });

  /* pagamenti */
  async function loadPayments() {
    var c = state.current; if (!c) return;
    var r = await sb.from('payments').select('*').eq('client_id', c.id).order('created_at', { ascending: false });
    var list = $('#paymentList'); list.textContent = '';
    if (r.error) { list.appendChild(el('li', { class: 'adm-error', text: errText(r.error) })); return; }
    if (!r.data.length) list.appendChild(el('li', { class: 'adm-muted', text: 'Nessun pagamento registrato. Arriveranno da Stripe dopo il collegamento del webhook.' }));
    r.data.forEach(function (p) {
      list.appendChild(el('li', { class: 'adm-log__item' }, [
        el('div', { class: 'adm-log__meta' }, [badge(LABEL.pay[p.status], TONE.pay[p.status]), el('time', { text: fmtTime(p.paid_at || p.created_at) })]),
        el('div', { class: 'adm-log__row' }, [
          el('span', { text: (p.amount_cents / 100).toLocaleString('it-IT', { style: 'currency', currency: (p.currency || 'eur').toUpperCase() }) }),
          el('span', { class: 'adm-muted', text: p.period_start ? fmtDate(p.period_start) + ' → ' + fmtDate(p.period_end) : p.stripe_invoice_id })
        ])
      ]));
    });
  }

  sb.auth.onAuthStateChange(function (event) { if (event === 'SIGNED_OUT') show('#viewLogin'); });
  boot().catch(function (e) { show('#viewLogin'); loginError(errText(e)); });
})();
