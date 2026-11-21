// Noifla Digital Studio · email all'admin per le nuove richieste dei clienti (Supabase Edge Function, Deno).
//
// La chiama l'area clienti (ticket.html) subito dopo l'invio di una richiesta,
// passando il codice del link personale del cliente.
// Pubblicazione:  supabase functions deploy ticket-notify --no-verify-jwt
//   (--no-verify-jwt perché il cliente non ha un login: la richiesta è accettata solo
//    con un codice cliente valido, controllato qui sotto)
// Segreti:        RESEND_API_KEY, MAIL_FROM, ADMIN_EMAIL, ADMIN_URL (gli stessi degli avvisi 36 mesi)
//                 ALLOWED_ORIGINS=https://noifla01.github.io (facoltativo, separati da virgola)
// SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY sono già disponibili nelle Edge Functions.
//
// La funzione non riceve né il testo della richiesta né l'email: legge dal database
// le richieste dei clienti non ancora segnalate e le invia all'indirizzo dell'admin.

import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { resendSender } from '../stripe-webhook/notify.js';
import { notifyTickets } from './handler.js';

const resendKey = Deno.env.get('RESEND_API_KEY') ?? '';
const mailFrom = Deno.env.get('MAIL_FROM') ?? '';
const adminEmail = Deno.env.get('ADMIN_EMAIL') ?? '';
const adminUrl = Deno.env.get('ADMIN_URL') ?? '';
const allowed = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false } },
);

function cors(req: Request) {
  const origin = req.headers.get('origin') ?? '';
  return {
    'Access-Control-Allow-Origin': !allowed.length ? '*' : (allowed.includes(origin) ? origin : allowed[0]),
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

const rpc = async (fn: string, args: Record<string, unknown>) => {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data;
};

Deno.serve(async (req) => {
  const headers = cors(req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'POST') return Response.json({ error: 'Metodo non consentito' }, { status: 405, headers });

  let token = '';
  try { token = String((await req.json()).token ?? ''); } catch { /* corpo non valido */ }
  if (!/^[0-9a-f]{64}$/.test(token)) return Response.json({ error: 'link non valido' }, { status: 400, headers });

  // solo chi ha un link cliente valido può far partire gli avvisi
  try { await rpc('portal_client_id', { p_token: token }); } catch {
    return Response.json({ error: 'link non valido' }, { status: 403, headers });
  }

  if (!resendKey || !mailFrom || !adminEmail) {
    return Response.json({ ok: true, result: 'email non configurate' }, { headers });
  }
  try {
    const result = await notifyTickets(rpc, resendSender(resendKey, mailFrom, adminEmail), adminUrl);
    console.log('ticket-notify:', result);
    return Response.json({ ok: true, result }, { headers });
  } catch (err) {
    // le richieste non segnalate restano in coda e partono al prossimo invio
    console.error('ticket-notify non inviato:', (err as Error).message);
    return Response.json({ ok: false }, { status: 502, headers });
  }
});
