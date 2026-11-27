// Pacchetto annuale 12+2: crea o annulla la fattura Stripe del pacchetto.
// Senza dipendenze, così si può provare anche fuori da Supabase.
//
// deps:
//   rpc(fn, args)       -> funzioni del database chiamate COME ADMIN (RLS e controlli is_admin)
//   getClient(id)       -> riga di client_overview letta come admin, o null
//   getPackage(id)      -> riga di annual_packages letta come admin, o null
//   getSettings()       -> riga di settings letta come admin
//   stripe              -> client Stripe, o null

const euro = (cents) => (cents / 100).toLocaleString('it-IT', { style: 'currency', currency: 'EUR' });
const PLAN = { piano_completo: 'Piano Completo', piano_base: 'Piano Base' };

export async function createPackage(clientId, deps) {
  if (!deps.stripe) return { ok: false, status: 500, error: 'Stripe non configurato: manca STRIPE_SECRET_KEY.' };
  const c = await deps.getClient(clientId);
  if (!c) return { ok: false, status: 404, error: 'Cliente non trovato o accesso non consentito.' };

  // Stripe manda la fattura per email: se su Stripe manca, uso quella della scheda cliente
  if (c.stripe_customer_id) {
    const cus = await deps.stripe.customers.retrieve(c.stripe_customer_id);
    if (cus.deleted) return { ok: false, status: 409, error: 'Il cliente Stripe collegato è stato eliminato.' };
    if (!cus.email) {
      if (!c.email) return { ok: false, status: 409, error: 'Serve un\'email: inseriscila nella scheda Dati (campo Email), salva e riprova.' };
      await deps.stripe.customers.update(c.stripe_customer_id, { email: c.email });
    }
  }

  // il database controlla tutto (customer ID, abbonamento, un solo pacchetto aperto) e fissa l'importo
  let pkg;
  try { pkg = await deps.rpc('package_open', { p_client_id: clientId }); }
  catch (err) { return { ok: false, status: 409, error: err.message }; }

  const s = await deps.getSettings();
  const total = pkg.paid_months + pkg.gift_months;
  const what = `Pacchetto annuale ${PLAN[pkg.plan] || ''}: ${pkg.paid_months} canoni da ${euro(pkg.monthly_rate_cents)} ` +
    `pagati in anticipo, ${total} canoni di servizio (${pkg.gift_months} in regalo)`;
  let invoice = null;
  try {
    invoice = await deps.stripe.invoices.create({
      customer: c.stripe_customer_id,
      collection_method: 'send_invoice',
      days_until_due: (s && s.package_days_until_due) || 7,
      pending_invoice_items_behavior: 'exclude',
      description: `${what}. Il credito viene caricato sul tuo conto e scala in automatico i prossimi ${total} canoni.`,
      metadata: { noifla_package_id: String(pkg.id), noifla_client_id: c.id },
    }, { idempotencyKey: `noifla-package-invoice-${pkg.id}` });
    await deps.stripe.invoiceItems.create({
      customer: c.stripe_customer_id,
      invoice: invoice.id,
      amount: pkg.amount_cents,
      currency: 'eur',
      description: what,
    }, { idempotencyKey: `noifla-package-item-${pkg.id}` });
    const fin = await deps.stripe.invoices.finalizeInvoice(invoice.id);
    // Stripe invia la fattura per email al cliente (se ha un'email); se non riesce il link resta valido
    let sent = false;
    try { await deps.stripe.invoices.sendInvoice(fin.id); sent = true; } catch (_) { sent = false; }
    await deps.rpc('package_set_invoice', { p_id: pkg.id, p_invoice_id: fin.id, p_url: fin.hosted_invoice_url });
    return { ok: true, package_id: pkg.id, amount_cents: pkg.amount_cents, invoice_url: fin.hosted_invoice_url, emailed: sent };
  } catch (err) {
    // la fattura non è partita: tolgo la bozza da Stripe e chiudo il pacchetto nel database
    if (invoice && invoice.id) {
      try { await deps.stripe.invoices.del(invoice.id); } catch (_) { /* già finalizzata o inesistente */ }
    }
    try { await deps.rpc('package_cancel', { p_id: pkg.id, p_note: 'Fattura non creata: ' + err.message }); } catch (_) { /* resta da annullare a mano */ }
    return { ok: false, status: 502, error: 'Stripe: ' + err.message };
  }
}

export async function cancelPackage(packageId, note, deps) {
  const p = await deps.getPackage(packageId);
  if (!p) return { ok: false, status: 404, error: 'Pacchetto non trovato o accesso non consentito.' };
  if (p.status === 'concluso' || p.status === 'annullato') return { ok: true, status_after: p.status };

  // fattura non ancora pagata: la annullo anche su Stripe
  if (p.status === 'in_attesa' && p.stripe_invoice_id) {
    if (!deps.stripe) return { ok: false, status: 500, error: 'Stripe non configurato: manca STRIPE_SECRET_KEY.' };
    const inv = await deps.stripe.invoices.retrieve(p.stripe_invoice_id);
    if (inv.status === 'paid') {
      return { ok: false, status: 409, error: 'La fattura risulta già pagata: il pacchetto si attiva da solo appena arriva la conferma di Stripe.' };
    }
    if (inv.status === 'open' || inv.status === 'uncollectible') await deps.stripe.invoices.voidInvoice(inv.id);
    else if (inv.status === 'draft') await deps.stripe.invoices.del(inv.id);
  }
  const status = await deps.rpc('package_cancel', { p_id: packageId, p_note: note || null });
  return { ok: true, status_after: status, was: p.status };
}
