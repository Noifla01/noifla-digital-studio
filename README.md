# Noifla Digital Studio — sito

Solo HTML, CSS, JavaScript vanilla e Bootstrap 5 (da CDN). Nessun framework, nessun npm, nessuna build:
i file funzionano così come sono, in locale e su GitHub Pages.

```
index.html            la home (tutti i contenuti sono qui, leggibili dai motori di ricerca)
privacy-policy.html   informativa privacy
cookie-policy.html    informativa cookie
css/style.css         stile del sito (variabili in cima al file)
css/legal.css         stile delle pagine legali
js/data.js            settori usati per le anteprime
js/mockups.js         anteprime di siti disegnate su canvas (concept, non lavori di clienti)
js/main.js            animazioni, modale contatto, banner cookie
images/               favicon, icona Apple, immagine Open Graph
robots.txt, sitemap.xml
```

## Anteprima locale
Si può aprire `index.html` con un doppio clic. Per provarlo come su GitHub Pages:

```bash
python -m http.server 5500
```

e aprire http://localhost:5500

## Pubblicazione
GitHub Pages: **Settings → Pages → Deploy from a branch → `main` / `(root)`**.
Tutti i percorsi sono relativi, quindi funziona sia su `utente.github.io/repo/` sia con un dominio
personalizzato (in quel caso aggiungere un file `CNAME`).

## Da completare
- numero WhatsApp reale: `js/main.js` (`WA_NUMBER`) e link nel footer di `index.html`
- P.IVA reale: footer di `index.html` e delle pagine legali
- dominio definitivo: `index.html` (canonical, og:url, og:image, JSON-LD), `robots.txt`, `sitemap.xml`
- campi evidenziati in giallo nelle pagine legali
- quando ci sono siti consegnati: sostituire i concept con screenshot reali

## Gestionale (area riservata)
`admin.html` è il gestionale clienti, ticket e abbonamenti, collegato a Supabase.
Il sito pubblico non dipende da Supabase. Istruzioni e stato dei passi: `supabase/README.md`.
