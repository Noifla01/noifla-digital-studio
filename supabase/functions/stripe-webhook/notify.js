// Email all'admin quando un cliente entra in una nuova fase dei 36 mesi.
// Si attiva solo se sono impostati RESEND_API_KEY, MAIL_FROM e ADMIN_EMAIL.
// Un errore qui non blocca il webhook: i clienti non segnalati restano in coda
// e vengono ritentati al pagamento successivo di un qualsiasi cliente.

const euro = (v) => Number(v).toLocaleString('it-IT', { style: 'currency', currency: 'EUR' });

export function loyaltyEmail(rows, adminUrl) {
  const lines = rows.map((r) => r.loyalty_state === 'da_applicare'
    ? `• ${r.business_name}: ${r.paid_months_count} mensilità pagate. Tariffa da ridurre: ${euro(r.monthly_rate)} → ${euro(r.loyalty_rate)}.`
    : `• ${r.business_name}: ${r.paid_months_count} mensilità pagate, ne mancano ${r.months_to_loyalty} ai 36 mesi (poi ${euro(r.monthly_rate)} → ${euro(r.loyalty_rate)}).`);
  const due = rows.filter((r) => r.loyalty_state === 'da_applicare').length;
  return {
    subject: due
      ? `Noifla · ${due === 1 ? '1 cliente ha' : due + ' clienti hanno'} completato i 36 mesi`
      : `Noifla · ${rows.length === 1 ? '1 cliente si avvicina' : rows.length + ' clienti si avvicinano'} ai 36 mesi`,
    text: ['Avviso automatico dal gestionale.', '', ...lines, '',
      adminUrl ? `Apri il gestionale per applicare la tariffa: ${adminUrl}` : 'Apri il gestionale per applicare la tariffa.'].join('\n'),
  };
}

// rpc(fn, args) -> dati del database; send({subject, text}) -> invia l'email
export async function notifyLoyalty(rpc, send, adminUrl) {
  const rows = (await rpc('loyalty_pending_notifications', {})) || [];
  if (!rows.length) return 'nessun avviso';
  await send(loyaltyEmail(rows, adminUrl));
  await rpc('mark_loyalty_notified', { p_ids: rows.map((r) => r.id) });
  return `email inviata per ${rows.length} clienti`;
}

// invio tramite Resend (https://resend.com): servono un dominio verificato e una chiave API
export function resendSender(apiKey, from, to) {
  return async ({ subject, text }) => {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, text }),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  };
}
