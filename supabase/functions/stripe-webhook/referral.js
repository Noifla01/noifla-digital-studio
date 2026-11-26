// Promo «Porta un amico»: trasforma i mesi gratis in un credito sul saldo Stripe del cliente.
// Il credito (customer balance) scala in automatico la fattura successiva dell'abbonamento:
// la fattura diventa da 0€ e il cliente non paga quel mese.
// Senza dipendenze, così si può provare fuori da Supabase.
//
// rpc(fn, args) -> dati del database (service_role)
// stripe        -> client Stripe (customers.listBalanceTransactions / createBalanceTransaction)

const DESCRIPTION = {
  mese_amico: 'Porta un amico: 1 mese gratis di benvenuto',
  mese_presentatore: 'Porta un amico: 1 mese gratis per aver presentato un amico',
};

// cerca un credito già creato per questo premio (es. se il database non ha fatto in tempo a segnarlo)
async function findExisting(stripe, customer, rewardId) {
  const list = await stripe.customers.listBalanceTransactions(customer, { limit: 100 });
  return (list.data || []).find((t) => t.metadata && t.metadata.noifla_referral_reward === String(rewardId)) || null;
}

export async function applyReferralCredits(rpc, stripe) {
  if (!stripe) return 'Stripe non configurato';
  const rows = (await rpc('referral_pending_credits', {})) || [];
  if (!rows.length) return 'nessun mese gratis da accreditare';

  const done = [];
  const failed = [];
  for (const r of rows) {
    try {
      const txn = (await findExisting(stripe, r.stripe_customer_id, r.id)) ||
        (await stripe.customers.createBalanceTransaction(
          r.stripe_customer_id,
          {
            amount: -Math.abs(r.amount_cents), // negativo = credito a favore del cliente
            currency: 'eur',
            description: DESCRIPTION[r.kind] || 'Porta un amico: 1 mese gratis',
            metadata: { noifla_referral_reward: String(r.id) },
          },
          { idempotencyKey: `noifla-referral-reward-${r.id}` },
        ));
      await rpc('mark_referral_applied', { p_id: r.id, p_txn: txn.id, p_amount_cents: Math.abs(txn.amount) });
      done.push(`${r.business_name} (${(Math.abs(txn.amount) / 100).toFixed(2)}€)`);
    } catch (err) {
      // resta «da applicare»: si ritenta al prossimo pagamento ricevuto
      failed.push(`${r.business_name}: ${err.message}`);
    }
  }
  return [done.length ? 'mesi gratis accreditati: ' + done.join(', ') : '', failed.length ? 'non accreditati: ' + failed.join('; ') : '']
    .filter(Boolean).join(' · ');
}
