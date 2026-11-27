// Pacchetto annuale 12+2: quando la fattura del pacchetto è pagata, carica sul saldo Stripe
// del cliente un credito pari a 14 canoni. Il credito scala in automatico le fatture mensili
// dell'abbonamento, che diventano da 0€ finché basta.
// Senza dipendenze, così si può provare fuori da Supabase.
//
// rpc(fn, args) -> dati del database (service_role)
// stripe        -> client Stripe (customers.listBalanceTransactions / createBalanceTransaction)

// la fattura del pacchetto porta nei metadata l'id del pacchetto (la crea la funzione annual-package)
export function packageIdOf(invoice) {
  const id = invoice && invoice.metadata && invoice.metadata.noifla_package_id;
  return id && /^\d+$/.test(String(id)) ? Number(id) : null;
}

// registra il pagamento del pacchetto: un errore qui fa ripetere l'evento a Stripe
export async function markPackagePaid(invoice, rpc) {
  const id = packageIdOf(invoice);
  if (!id) return null;
  const paidAt = invoice.status_transitions && invoice.status_transitions.paid_at;
  return rpc('package_mark_paid', {
    p_id: id,
    p_invoice_id: invoice.id,
    p_total_cents: invoice.total ?? invoice.amount_paid ?? 0,
    p_paid_at: paidAt ? new Date(paidAt * 1000).toISOString() : null,
  });
}

async function findExisting(stripe, customer, packageId) {
  const list = await stripe.customers.listBalanceTransactions(customer, { limit: 100 });
  return (list.data || []).find((t) => t.metadata && t.metadata.noifla_annual_package === String(packageId)) || null;
}

export async function applyPackageCredits(rpc, stripe) {
  if (!stripe) return 'Stripe non configurato';
  const rows = (await rpc('package_pending_credits', {})) || [];
  if (!rows.length) return 'nessun pacchetto da accreditare';

  const done = [];
  const failed = [];
  for (const r of rows) {
    try {
      const txn = (await findExisting(stripe, r.stripe_customer_id, r.id)) ||
        (await stripe.customers.createBalanceTransaction(
          r.stripe_customer_id,
          {
            amount: -Math.abs(r.credit_cents), // negativo = credito a favore del cliente
            currency: 'eur',
            description: `Pacchetto annuale: ${r.paid_months} canoni pagati + ${r.gift_months} in regalo`,
            metadata: { noifla_annual_package: String(r.id) },
          },
          { idempotencyKey: `noifla-annual-package-${r.id}` },
        ));
      await rpc('mark_package_credited', { p_id: r.id, p_txn: txn.id, p_credit_cents: Math.abs(txn.amount) });
      done.push(`${r.business_name} (${(Math.abs(txn.amount) / 100).toFixed(2)}€)`);
    } catch (err) {
      // resta «pagato»: si ritenta al prossimo pagamento ricevuto
      failed.push(`${r.business_name}: ${err.message}`);
    }
  }
  return [done.length ? 'pacchetti accreditati: ' + done.join(', ') : '', failed.length ? 'non accreditati: ' + failed.join('; ') : '']
    .filter(Boolean).join(' · ');
}
