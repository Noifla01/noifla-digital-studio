/* Noifla Digital Studio — configurazione Supabase (gestionale e area clienti).
   - Aperto da localhost / 127.0.0.1: usa il Supabase locale (`npx supabase start`).
     La chiave locale è quella dimostrativa uguale per tutte le installazioni locali.
   - Online: usa il progetto vero (Dashboard → Project Settings → API).
   La chiave "anon" è pubblica per progetto: i dati sono protetti dalle regole RLS del database.
   NON inserire mai qui la chiave "service_role". */
(function () {
  var local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  window.NOIFLA_SUPABASE = local ? {
    supabaseUrl: 'http://127.0.0.1:54321',
    supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'
  } : {
    supabaseUrl: 'https://TUO-PROGETTO.supabase.co',
    supabaseAnonKey: 'INCOLLA-QUI-LA-CHIAVE-ANON'
  };
})();
