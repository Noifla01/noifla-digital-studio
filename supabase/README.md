# Gestionale Noifla · backend su Supabase

Il sito pubblico resta statico su GitHub Pages. Il gestionale (`admin.html`) e l'area clienti (`ticket.html`)
sono pagine statiche in più che leggono e scrivono su Supabase: database Postgres, login e regole di accesso (RLS) nel database.
Questa cartella non viene pubblicata su GitHub Pages (vedi `_config.yml`).

```
supabase/
  migrations/20261120000000_gestionale.sql      schema, vista dashboard, funzioni, permessi
  migrations/20261120010000_portale_clienti.sql funzioni dell'area clienti (link personale)
  migrations/20261120020000_stripe.sql          funzioni per gli eventi Stripe
  migrations/20261120030000_avvisi_36_mesi.sql  coda degli avvisi email per i 36 mesi
  migrations/20261121000000_modifiche_dal_pagamento.sql  modifiche incluse contate dall'ultimo pagamento
  migrations/20261121010000_avvisi_ticket.sql   coda delle email per le nuove richieste dei clienti
  migrations/20261126000000_porta_un_amico.sql  promo «Porta un amico»: codici amico e mesi gratis
  migrations/20261127000000_pacchetto_annuale.sql  pacchetto annuale 12+2: fattura anticipata e credito di 14 canoni
  functions/stripe-webhook/                     riceve i webhook Stripe e manda gli avvisi email
  functions/apply-loyalty-price/                applica la tariffa ridotta su Stripe e nel database
  functions/ticket-notify/                      email all'admin per ogni nuova richiesta di un cliente
  functions/annual-package/                     crea o annulla la fattura Stripe del pacchetto annuale
admin.html, css/admin.css, js/admin.js          gestionale
ticket.html, js/ticket.js                       area clienti: richieste e storico
js/supabase-config.js                           URL e chiave anon del progetto (usato da entrambe)
```

## Stato dei passi
1. **Schema del database**: fatto
2. **Area admin** (`admin.html`): fatto
3. **Area clienti** con link personale (`ticket.html`): fatto
4. **Webhook Stripe** (`functions/stripe-webhook`): fatto
5. **Tariffa ridotta su Stripe** dopo 36 mensilità ed **email di avviso**: fatto
6. **Modifiche incluse azzerate a ogni pagamento**: fatto
7. **Email per ogni nuova richiesta** del cliente: fatto
8. **Promo «Porta un amico»** con mesi gratis accreditati su Stripe: fatto
9. **Pacchetto annuale 12+2** con fattura anticipata e credito su Stripe: fatto

## Messa in funzione (passi 1, 2 e 3)

### 1. Crea il progetto
- Su [supabase.com](https://supabase.com) crea un progetto nella regione **Central EU (Frankfurt)**.
- Piano gratuito: il progetto va in pausa dopo 7 giorni senza attività.
  Prima di incassare davvero con Stripe conviene il piano Pro, così i webhook trovano sempre il database attivo.

### 2. Crea il database
- Apri **SQL Editor → New query** ed esegui, nell'ordine, i file di `migrations/`:
  `20261120000000_gestionale.sql`, `20261120010000_portale_clienti.sql`, `20261120020000_stripe.sql`,
  `20261120030000_avvisi_36_mesi.sql`, `20261121000000_modifiche_dal_pagamento.sql`,
  `20261121010000_avvisi_ticket.sql`, `20261126000000_porta_un_amico.sql`.
- In alternativa, con la Supabase CLI: `supabase link` e poi `supabase db push`.

### 3. Crea il tuo utente admin
- **Authentication → Users → Add user**: inserisci la tua email e una password lunga.
- **Authentication → Sign In / Providers**: disattiva **Allow new users to sign up**.
  Così nessuno può registrarsi da solo.
- Nell'editor SQL, con la tua email:
  ```sql
  insert into public.admins (user_id)
  select id from auth.users where email = 'la-tua-email@esempio.it';
  ```

### 4. Collega la pagina
- **Project Settings → API**: copia **Project URL** e la chiave **anon public**.
- Incollale in `js/supabase-config.js`.
  La chiave anon è pubblica per progetto: senza login admin il database non restituisce nulla.
  **Non usare mai la chiave `service_role` nella pagina.**
- In **Authentication → URL Configuration** imposta come Site URL l'indirizzo del sito,
  per esempio `https://noifla01.github.io/noifla-digital-studio/`.

### 5. Entra
Apri `admin.html` sul sito (o in locale con `python -m http.server 5500`) e accedi.

### 6. Dai il link ai clienti
Nella scheda del cliente premi **Genera link ticket** e copia il link: si vede una volta sola.
Mandalo al cliente (WhatsApp o email) e chiedigli di salvarlo tra i preferiti.
Se il link finisce nelle mani sbagliate, premi **Rigenera link ticket**: il vecchio smette subito di funzionare.

## Collegare Stripe (passo 4)
Prova tutto prima in **modalità test** di Stripe, poi ripeti con le chiavi live.

1. **Installa la Supabase CLI**: è uno strumento da riga di comando, non entra nel sito.
   Su Windows: `scoop install supabase`, oppure `npx supabase` se hai Node.
   Poi esegui `supabase login` e `supabase link --project-ref <id-progetto>`.
2. **Pubblica la funzione** dalla cartella del repo:
   ```bash
   supabase functions deploy stripe-webhook --no-verify-jwt
   ```
   `--no-verify-jwt` serve perché Stripe non ha un login Supabase: ogni richiesta è verificata con la firma Stripe.
3. **Crea il webhook su Stripe**: Developers → Webhooks → Add endpoint.
   - URL: `https://<id-progetto>.supabase.co/functions/v1/stripe-webhook`
   - Eventi: `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted`
4. **Inserisci i segreti** in Supabase: la chiave segreta Stripe e il «Signing secret» del webhook appena creato.
   ```bash
   supabase secrets set STRIPE_SECRET_KEY=sk_test_... STRIPE_WEBHOOK_SECRET=whsec_...
   ```
5. **Collega ogni cliente**: nella scheda del cliente inserisci il **customer ID** (`cus_…`) e il **subscription ID** (`sub_…`).
   Se un pagamento arriva prima che tu li abbia inseriti, non va perso:
   - la dashboard mostra l'avviso «pagamenti non collegati»;
   - appena inserisci il customer ID, i pagamenti vengono collegati e conteggiati.
6. **Prova**: dalla pagina del webhook su Stripe usa «Send test event», oppure crea un abbonamento di prova.
   - L'esito di ogni evento si legge in Supabase → Edge Functions → stripe-webhook → Logs.
   - In alternativa, con la Stripe CLI: `stripe trigger invoice.paid`.

### Cosa fa ogni evento
| Evento | Effetto |
|---|---|
| `invoice.paid` | Registra il pagamento. Se è un rinnovo o la prima fattura di un abbonamento con importo, aggiunge **+1 mensilità** (una sola volta per fattura). Il cliente torna «Attivo». |
| `invoice.payment_failed` | Il pagamento risulta «Fallito» e il cliente passa a «In rinnovo». Se la fattura era già pagata, l'evento viene ignorato. |
| `customer.subscription.updated` | Aggiorna lo stato: active diventa Attivo; past_due, unpaid o paused diventano In rinnovo; canceled diventa Scaduto. Copia anche il prezzo attuale come tariffa. |
| `customer.subscription.deleted` | Il cliente passa a «Scaduto». |

**Non contano come mensilità:**
- conguagli per cambio piano;
- fatture a 0€;
- extra una tantum, come la targhetta da 25€ o il rifacimento.

Se lo stesso evento arriva due volte (Stripe a volte lo rinvia), il secondo viene ignorato.

## Tariffa ridotta su Stripe ed email (passo 5)

### Prezzi ridotti su Stripe
1. Su Stripe, nei due prodotti, crea i prezzi ricorrenti ridotti: **Completo 29€** e **Base 24€**,
   con lo stesso intervallo degli abbonamenti attuali (30 giorni o mensile).
2. Copia i due ID `price_…` e inseriscili come segreti, insieme all'indirizzo del sito:
   ```bash
   supabase secrets set STRIPE_PRICE_COMPLETO_RIDOTTO=price_... STRIPE_PRICE_BASE_RIDOTTO=price_... ALLOWED_ORIGINS=https://noifla01.github.io
   ```
3. Pubblica la funzione. Qui il controllo del login resta attivo: solo l'admin può chiamarla.
   ```bash
   supabase functions deploy apply-loyalty-price
   ```

Cosa succede quando premi **Applica** nella scheda di un cliente con 36 mensilità:
- la funzione controlla di nuovo che tu sia admin e che il cliente sia davvero «da applicare»;
- su Stripe cambia il prezzo dell'abbonamento, senza conguaglio: il nuovo importo parte dalla prossima fattura;
- nel database registra la nuova tariffa e annota il cambio nel registro del cliente;
- se il database rifiuta dopo il cambio su Stripe, rimette su Stripe il prezzo di prima;
- se il cliente non ha un abbonamento Stripe collegato, cambia solo il gestionale;
- se la funzione non è ancora pubblicata, il gestionale propone di registrare la tariffa solo nel database.
  In quel caso su Stripe va cambiata a mano.

### Email di avviso (facoltative)
Dopo ogni pagamento ricevuto da Stripe arriva un'email se un cliente:
- ha raggiunto la **34ª mensilità** («mancano 2 rate»);
- oppure ha raggiunto la **36ª** («tariffa da ridurre»).

Ogni fase si segnala una volta sola per cliente. I clienti scaduti non generano avvisi.
Se un invio fallisce, il cliente resta in coda e parte al pagamento successivo.

Per attivarle:
1. Crea un account su [resend.com](https://resend.com). Il piano gratuito arriva a 3.000 email al mese.
2. Verifica il dominio da cui inviare e crea una chiave API.
3. Imposta i segreti e ripubblica il webhook:
   ```bash
   supabase secrets set RESEND_API_KEY=re_... MAIL_FROM="Gestionale Noifla <avvisi@tuodominio.it>" ADMIN_EMAIL=tua@email.it ADMIN_URL=https://noifla01.github.io/noifla-digital-studio/admin.html
   ```
   ```bash
   supabase functions deploy stripe-webhook --no-verify-jwt
   ```

Senza questi segreti le email non partono, ma badge e avvisi nella dashboard funzionano lo stesso.

### Email per ogni nuova richiesta del cliente
Quando un cliente invia una richiesta dall'area clienti ti arriva un'email con attività, tipo di richiesta,
titolo, descrizione, referente, telefono e modifiche incluse già usate.
Usa gli stessi segreti delle email di avviso (`RESEND_API_KEY`, `MAIL_FROM`, `ADMIN_EMAIL`, `ADMIN_URL`).
Pubblica la funzione:
```bash
supabase functions deploy ticket-notify --no-verify-jwt
```
- La pagina passa alla funzione solo il codice del link: la funzione lo verifica e legge dal database
  le richieste non ancora segnalate. Un estraneo senza un link valido non può far partire email.
- Un'email per richiesta, una volta sola. Se l'invio fallisce, la richiesta resta in coda e parte
  alla richiesta successiva di un qualsiasi cliente. Le richieste inserite da te nel gestionale non generano email.
- Per la notifica sul telefono basta l'app Gmail (o della tua casella) con le notifiche attive.

## Promo «Porta un amico» (passo 8)
Regolamento pubblico: `porta-un-amico.html`. Per attivarla:
1. Esegui `migrations/20261126000000_porta_un_amico.sql` (dopo le altre).
   Ogni cliente, anche quelli già presenti, riceve un **codice amico** di 6 caratteri.
2. Ripubblica il webhook, che ora accredita anche i mesi gratis:
   ```bash
   supabase functions deploy stripe-webhook --no-verify-jwt
   ```
   Non servono segreti nuovi: usa la stessa `STRIPE_SECRET_KEY`.

Come si usa:
- Il nuovo cliente scrive il codice amico nel modulo del sito: arriva nel messaggio WhatsApp.
  Il link che il cliente gira all'amico dall'area clienti (`?amico=CODICE`) lo precompila.
- Nella scheda del nuovo cliente, campo **Presentato da (codice amico)**: inserisci il codice e salva.
  Si può fare finché il cliente ha pagato al massimo il primo canone.
- Quando il nuovo cliente paga il primo canone vengono creati i premi:
  - **mese gratis di benvenuto** per l'amico (scala il secondo canone);
  - **mese gratis** per chi lo ha presentato, fino a 12 in 12 mesi (`settings.referral_max_months_year`);
  - al **3° amico** (`settings.referral_gift_at`) una **targhetta recensioni** da consegnare a mano.
- Dopo ogni pagamento ricevuto, il webhook accredita i mesi gratis pronti come **credito sul saldo Stripe** del cliente.
  Il credito scala in automatico la fattura successiva, che diventa da 0€.
  - Riceve il credito solo chi è collegato a Stripe, attivo e senza pagamenti falliti; gli altri restano in attesa.
  - Chi è scaduto prima dell'accredito perde il premio.
  - Se il webhook ritenta, non crea un secondo credito: controlla quelli già presenti su Stripe.
- I mesi gratis **non contano** come mensilità per i 36 mesi, ma **azzerano le modifiche incluse** come un rinnovo.
- Nella scheda cliente, scheda **Porta un amico**: codice, amici presentati, premi.
  Puoi segnare una targhetta come consegnata, un mese come accreditato a mano o annullare un premio.
- La dashboard mostra un avviso quando ci sono targhette da consegnare o mesi in attesa.
- Per sospendere la promo: `update public.settings set referral_enabled = false;`
  I premi già creati restano validi.

## Pacchetto annuale 12+2 (passo 9)
Il cliente paga in anticipo 12 canoni e riceve 14 canoni di servizio (2 in regalo).
Per attivarlo:
1. Esegui `migrations/20261127000000_pacchetto_annuale.sql` (dopo le altre).
2. Pubblica la nuova funzione e ripubblica il webhook:
   ```bash
   supabase functions deploy annual-package
   supabase functions deploy stripe-webhook --no-verify-jwt
   ```
   Non servono segreti nuovi: usano la stessa `STRIPE_SECRET_KEY`.
   Se usi una chiave con permessi limitati, deve poter scrivere **Invoices**, **Invoice items** e **Customers**.

Come si usa:
- Il cliente deve avere lo **Stripe customer ID** nella scheda. Può avere già un abbonamento attivo oppure no.
- Scheda cliente → **Pacchetto annuale** → **Crea fattura del pacchetto**:
  - la funzione crea su Stripe una fattura da 12 canoni alla tariffa attuale del cliente (Completo 588€, Base 348€),
    con scadenza a 7 giorni (`settings.package_days_until_due`);
  - Stripe la manda per email al cliente; nella scheda trovi anche il link di pagamento da girare su WhatsApp.
- Quando il cliente paga, il webhook carica sul suo **saldo Stripe** un credito pari a 14 canoni
  (l'importo pagato + 2 canoni in regalo).
- Le fatture dell'abbonamento diventano da **0€** finché il credito basta.
  - **Cliente nuovo**: crea l'abbonamento su Stripe **dopo** il pagamento del pacchetto, così anche la prima fattura è da 0€.
  - Ogni rinnovo da 0€ consuma un mese del pacchetto: i primi 12 **contano** come mensilità pagate per i 36 mesi,
    gli ultimi 2 sono in regalo e **non contano**.
  - Le **modifiche incluse** ripartono a ogni rinnovo, come sempre: 3 ogni 30 giorni, non 42 tutte insieme.
  - Finiti i 14 mesi, l'abbonamento torna da solo al pagamento mensile. Il cliente può comprare un nuovo pacchetto.
- Un solo pacchetto aperto per cliente.
- **Annullare la fattura** non pagata: pulsante nella scheda, la annulla anche su Stripe.
- **Disdetta durante il pacchetto**: la scheda mostra il **rimborso** dovuto
  (importo pagato meno i canoni già goduti a prezzo pieno, minimo 0€). Il rimborso e l'azzeramento del credito
  residuo si fanno **a mano su Stripe**; poi premi **Chiudi pacchetto** per registrarlo.
- Se nello stesso periodo il cliente ha anche un mese gratis «Porta un amico», i rinnovi da 0€ si attribuiscono prima
  al pacchetto: il conteggio delle mensilità resta giusto, il pacchetto risulta finito un mese prima.
- Per sospendere l'offerta: `update public.settings set package_enabled = false;` I pacchetti già pagati restano validi.

## Regole implementate
- **Mensilità e 36 mesi**:
  - dalla mensilità indicata in `settings.loyalty_warning_from` (34) compare l'avviso;
  - dalla 36ª compare il pulsante per applicare la nuova tariffa (Completo 49→29€, Base 29→24€);
  - la funzione rifiuta l'applicazione prima della 36ª e una seconda volta;
  - ogni applicazione viene annotata nel registro del cliente.
  - Soglie e tariffe si cambiano nella tabella `settings`.
- **Modifiche del mese**:
  - conta i ticket «Modifica inclusa» aperti dall'ultimo pagamento registrato (una mensilità conteggiata), esclusi i rifiutati;
  - ogni rinnovo pagato azzera il contatore; un pagamento fallito o un conguaglio no;
  - clienti senza pagamenti Stripe: mese solare corrente, con l'ora italiana;
  - quota: 3 per il Completo, 0 per il Base, dove le modifiche sono a pagamento.
- **Date di chiusura dei ticket**: impostate e azzerate in automatico quando cambia lo stato.
- **Link ticket del cliente**:
  - nel database si salva solo l'hash sha256 del link;
  - il link si vede una volta sola, al momento della generazione;
  - rigenerarlo disattiva quello vecchio.
- **Area clienti** (`ticket.html?t=…`):
  - nessun account per il cliente: il codice nel link (256 bit casuali) lo identifica;
  - la pagina chiama solo due funzioni del database, `client_portal` e `client_portal_create_ticket`;
  - le funzioni restituiscono nome dell'attività, piano, modifiche del mese e storico dei ticket del cliente,
    senza note interne, contatti o dati Stripe;
  - tipi di richiesta:
    - «Modifica»: inclusa nel Completo; per il Base diventa extra, perché le modifiche costano 20€/ora;
    - «Nuova funzionalità»: diventa extra / preventivo;
    - «Problema»: diventa assistenza;
  - limiti: massimo 5 richieste in 24 ore per cliente, titolo da 3 a 120 caratteri, descrizione fino a 4000;
  - con l'abbonamento scaduto il cliente vede lo storico ma non può aprire nuove richieste;
  - dalla dashboard puoi cambiare la categoria di ogni ticket, per esempio da «Modifica inclusa» a «Extra».
- **Permessi**: solo gli utenti in `public.admins` leggono e scrivono. Gli altri utenti autenticati e i visitatori anonimi non vedono nulla.
