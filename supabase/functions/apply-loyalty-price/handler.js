// Applica la tariffa ridotta dopo 36 mensilità: prima su Stripe, poi nel database.
// Senza dipendenze, così si può provare fuori da Supabase.
//
// deps:
//   getClient(id)            -> riga di client_overview letta COME ADMIN (RLS), o null
//   applyInDb(id)            -> chiama apply_loyalty_rate COME ADMIN, restituisce la nuova tariffa
//   stripe                   -> client Stripe (subscriptions.retrieve / subscriptions.update), o null
//   priceIds                 -> { piano_completo: 'price_...', piano_base: 'price_...' }

export async function applyLoyaltyPrice(clientId, deps) {
  const c = await deps.getClient(clientId);
  if (!c) return { ok: false, status: 404, error: 'Cliente non trovato o accesso non consentito.' };
  if (c.loyalty_state !== 'da_applicare') {
    return { ok: false, status: 409, error: c.loyalty_state === 'applicata'
      ? 'La tariffa ridotta è già stata applicata.'
      : `Il cliente ha pagato ${c.paid_months_count} mensilità: la tariffa ridotta si applica dalla 36ª.` };
  }

  // nessun abbonamento Stripe collegato: si registra solo nel database
  if (!c.stripe_subscription_id) {
    const rate = await deps.applyInDb(clientId);
    return { ok: true, stripe: 'non collegato', rate };
  }

  const priceId = deps.priceIds && deps.priceIds[c.plan];
  if (!deps.stripe || !priceId) {
    return { ok: false, status: 500, error: 'Stripe non configurato: mancano la chiave o il prezzo ridotto per questo piano (vedi supabase/README.md).' };
  }

  const sub = await deps.stripe.subscriptions.retrieve(c.stripe_subscription_id);
  const item = sub.items && sub.items.data && sub.items.data[0];
  if (!item) return { ok: false, status: 409, error: 'Abbonamento Stripe senza voci: controlla su Stripe.' };
  const oldPriceId = item.price && item.price.id;

  // il nuovo prezzo vale dalla prossima fattura: nessun conguaglio sul periodo in corso
  if (oldPriceId !== priceId) {
    await deps.stripe.subscriptions.update(sub.id, {
      items: [{ id: item.id, price: priceId }],
      proration_behavior: 'none',
    });
  }

  try {
    const rate = await deps.applyInDb(clientId);
    return { ok: true, stripe: 'aggiornato', rate };
  } catch (err) {
    // il database ha rifiutato: rimetto il prezzo di prima su Stripe per non lasciare dati incoerenti
    if (oldPriceId && oldPriceId !== priceId) {
      try {
        await deps.stripe.subscriptions.update(sub.id, { items: [{ id: item.id, price: oldPriceId }], proration_behavior: 'none' });
      } catch (revertErr) {
        return { ok: false, status: 500, error: `Database: ${err.message}. ATTENZIONE: prezzo cambiato su Stripe ma non ripristinato (${revertErr.message}).` };
      }
    }
    return { ok: false, status: 500, error: `Database: ${err.message}. Su Stripe il prezzo è rimasto quello di prima.` };
  }
}
