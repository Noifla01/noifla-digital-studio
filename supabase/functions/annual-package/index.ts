// Noifla Digital Studio · pacchetto annuale 12+2 (Supabase Edge Function, Deno).
//
// La chiamano i pulsanti del gestionale con il login dell'admin:
//   { action: 'create', client_id }        -> crea e invia la fattura Stripe del pacchetto
//   { action: 'cancel', package_id, note } -> annulla la fattura non pagata o chiude il pacchetto (disdetta)
// Il credito di 14 canoni lo carica il webhook stripe-webhook quando la fattura viene pagata.
//
// Pubblicazione:  supabase functions deploy annual-package
//   (il controllo del login Supabase resta ATTIVO: senza sessione la richiesta è rifiutata)
// Segreti:        STRIPE_SECRET_KEY (già impostato per il webhook)
//                 ALLOWED_ORIGINS=https://noifla01.github.io (facoltativo, separati da virgola)

import Stripe from 'npm:stripe@17.7.0';
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { cancelPackage, createPackage } from './handler.js';

const stripeKey = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
const stripe = stripeKey ? new Stripe(stripeKey, { httpClient: Stripe.createFetchHttpClient() }) : null;
const allowed = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);

function cors(req: Request) {
  const origin = req.headers.get('origin') ?? '';
  return {
    'Access-Control-Allow-Origin': !allowed.length ? '*' : (allowed.includes(origin) ? origin : allowed[0]),
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

Deno.serve(async (req) => {
  const headers = cors(req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'POST') return Response.json({ error: 'Metodo non consentito' }, { status: 405, headers });

  const auth = req.headers.get('Authorization') ?? '';
  const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '', {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });

  const { data: isAdmin } = await supabase.rpc('is_admin');
  if (isAdmin !== true) return Response.json({ error: 'Non autorizzato' }, { status: 403, headers });

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* corpo non valido */ }

  const deps = {
    stripe,
    rpc: async (fn: string, args: Record<string, unknown>) => {
      const { data, error } = await supabase.rpc(fn, args);
      if (error) throw new Error(error.message);
      return data;
    },
    getClient: async (id: string) => {
      const { data, error } = await supabase.from('client_overview').select('*').eq('id', id).maybeSingle();
      if (error) throw new Error(error.message);
      return data;
    },
    getPackage: async (id: number) => {
      const { data, error } = await supabase.from('annual_packages').select('*').eq('id', id).maybeSingle();
      if (error) throw new Error(error.message);
      return data;
    },
    getSettings: async () => {
      const { data } = await supabase.from('settings').select('*').eq('id', 1).maybeSingle();
      return data;
    },
  };

  try {
    let result;
    if (body.action === 'create' && typeof body.client_id === 'string' && /^[0-9a-f-]{36}$/i.test(body.client_id)) {
      result = await createPackage(body.client_id, deps);
    } else if (body.action === 'cancel' && Number.isInteger(body.package_id)) {
      result = await cancelPackage(body.package_id as number, typeof body.note === 'string' ? body.note.slice(0, 500) : '', deps);
    } else {
      return Response.json({ ok: false, error: 'Richiesta non valida' }, { status: 400, headers });
    }
    console.log('annual-package', body.action, JSON.stringify(result));
    return Response.json(result, { status: result.ok ? 200 : result.status, headers });
  } catch (err) {
    console.error('annual-package', body.action, (err as Error).message);
    return Response.json({ ok: false, error: 'Stripe: ' + (err as Error).message }, { status: 502, headers });
  }
});
