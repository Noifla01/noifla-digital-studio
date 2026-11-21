// Email all'admin per ogni nuova richiesta inviata da un cliente dall'area clienti.
// Logica separata da index.ts per poterla provare senza Deno.

const KIND = {
  modifica_inclusa: 'Modifica inclusa',
  extra_preventivo: 'Nuova funzionalità / extra',
  bug_assistenza: 'Problema / assistenza',
};
const PLAN = { piano_completo: 'Piano Completo', piano_base: 'Piano Base' };

const when = (v) => new Intl.DateTimeFormat('it-IT', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome',
}).format(new Date(v));

export function ticketEmail(t, adminUrl) {
  const kind = KIND[t.category] ?? t.category;
  const lines = [
    `Nuova richiesta da ${t.business_name}`,
    '',
    `Tipo: ${kind}`,
    `Titolo: ${t.title}`,
    '',
    t.description ? t.description : '(nessuna descrizione)',
    '',
    `Cliente: ${t.business_name}${t.contact_name ? ' · ' + t.contact_name : ''}${t.phone ? ' · ' + t.phone : ''}`,
    `Piano: ${PLAN[t.plan] ?? t.plan}`,
  ];
  if (t.plan === 'piano_completo') {
    lines.push(`Modifiche incluse usate: ${t.changes_used}/${t.changes_quota}`);
  }
  lines.push(`Inviata il: ${when(t.created_at)}`, '');
  lines.push(adminUrl ? `Apri il gestionale: ${adminUrl}` : 'Apri il gestionale per gestirla.');
  return { subject: `Noifla · ${kind}: ${t.business_name} – ${t.title}`.slice(0, 180), text: lines.join('\n') };
}

// rpc(fn, args) -> dati del database; send({subject, text}) -> invia l'email
// Un'email per richiesta: ogni richiesta è segnata subito dopo il suo invio,
// così un errore a metà non fa ripartire quelle già inviate.
export async function notifyTickets(rpc, send, adminUrl) {
  const rows = (await rpc('ticket_pending_notifications', {})) || [];
  let sent = 0;
  for (const t of rows) {
    await send(ticketEmail(t, adminUrl));
    await rpc('mark_tickets_notified', { p_ids: [t.id] });
    sent++;
  }
  return sent ? `email inviate: ${sent}` : 'nessuna richiesta da segnalare';
}
