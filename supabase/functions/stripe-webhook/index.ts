// Noifla Digital Studio · webhook Stripe (Supabase Edge Function, Deno).
//
// Pubblicazione:  supabase functions deploy stripe-webhook --no-verify-jwt
//   (--no-verify-jwt perché Stripe non invia il login di Supabase: l'autenticità
//    è garantita dalla firma Stripe verificata qui sotto)
// Segreti:        supabase secrets set STRIPE_SECRET_KEY=sk_... STRIPE_WEBHOOK_SECRET=whsec_...
// SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY sono già disponibili nelle Edge Functions.
//
// Eventi gestiti: invoice.paid, invoice.payment_failed,
//                 customer.subscription.updated, customer.subscription.deleted
// Dopo ogni invoice.paid accredita anche i mesi gratis della promo «Porta un amico»
// e il credito dei pacchetti annuali pagati.

import Stripe from 'npm:stripe@17.7.0';
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { handleStripeEvent } from './handler.js';
import { notifyLoyalty, resendSender } from './notify.js';
import { applyReferralCredits } from './referral.js';
import { applyPackageCredits, markPackagePaid } from './package.js';

// avvisi email per i 36 mesi (facoltativi): RESEND_API_KEY, MAIL_FROM, ADMIN_EMAIL, ADMIN_URL
const resendKey = Deno.env.get('RESEND_API_KEY') ?? '';
const mailFrom = Deno.env.get('MAIL_FROM') ?? '';
const adminEmail = Deno.env.get('ADMIN_EMAIL') ?? '';
const adminUrl = Deno.env.get('ADMIN_URL') ?? '';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  httpClient: Stripe.createFetchHttpClient(),
});
const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? '';
const cryptoProvider = Stripe.createSubtleCryptoProvider();

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false } },
);

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Metodo non consentito', { status: 405 });

  const signature = req.headers.get('stripe-signature');
  if (!signature || !webhookSecret) return new Response('Firma mancante', { status: 400 });

  // la firma si verifica sul corpo esatto ricevuto, prima di qualsiasi parsing
  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, signature, webhookSecret, undefined, cryptoProvider);
  } catch (err) {
    console.error('Firma Stripe non valida:', (err as Error).message);
    return new Response('Firma non valida', { status: 400 });
  }

  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await supabase.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data;
  };

  try {
    const result = await handleStripeEvent(event, rpc);
    console.log(event.type, event.id, '→', result);

    // pacchetto annuale: registra il pagamento (un errore qui fa ripetere l'evento: è idempotente)
    // e carica subito il credito di 14 canoni sul saldo Stripe del cliente
    if (event.type === 'invoice.paid') {
      const pkg = await markPackagePaid(event.data.object, rpc);
      if (pkg) console.log('pacchetto annuale:', pkg);
      try {
        console.log('pacchetto annuale:', await applyPackageCredits(rpc, stripe));
      } catch (err) {
        console.error('pacchetto annuale non accreditato:', (err as Error).message);
      }
    }

    // promo «Porta un amico»: dopo un pagamento accredita su Stripe i mesi gratis pronti
    // (anche quelli nati da questo pagamento). Un errore qui non fa ripetere l'evento:
    // i premi restano in coda e si ritentano al prossimo pagamento.
    if (event.type === 'invoice.paid') {
      try {
        console.log('porta un amico:', await applyReferralCredits(rpc, stripe));
      } catch (err) {
        console.error('porta un amico non accreditato:', (err as Error).message);
      }
    }

    // dopo un pagamento le mensilità possono essere salite: avvisa l'admin se qualcuno
    // è entrato nella fase "in arrivo" (34ª) o "da applicare" (36ª). Un errore qui non
    // fa ripetere l'evento a Stripe: i clienti restano in coda per il prossimo pagamento.
    if (event.type === 'invoice.paid' && resendKey && mailFrom && adminEmail) {
      try {
        console.log('avvisi 36 mesi:', await notifyLoyalty(rpc, resendSender(resendKey, mailFrom, adminEmail), adminUrl));
      } catch (err) {
        console.error('avvisi 36 mesi non inviati:', (err as Error).message);
      }
    }
    return Response.json({ received: true, result });
  } catch (err) {
    // errore temporaneo (es. database non raggiungibile): rispondendo 500 Stripe ritenta più tardi
    console.error(event.type, event.id, 'errore:', (err as Error).message);
    return new Response('Errore temporaneo', { status: 500 });
  }
});
