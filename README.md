# Bills (Facturas)

A simple, phone-first bill tracker, in English and Costa Rican Spanish, in dollars or colones. Sign in with your email (a 6-digit code, no password), keep your own private list of bills, and tap the circle when one is paid. It installs on an iPhone Home Screen (Share, then Add to Home Screen).

Static site (one `index.html`, plain JavaScript, no build step) hosted on GitHub Pages, with [Supabase](https://supabase.com) for sign-in and storage.

## Files

| File | What it is |
|---|---|
| `index.html` | The whole app: look, bill logic, sign-in screens, and storage code |
| `config.js` | The Supabase project URL and **publishable** key. Both are meant to be public. Never put a `sb_secret_...` or `service_role` key here |
| `supabase/schema.sql` | The bills table (`public.docs`) with its Row Level Security rules, plus the daily-limit counter for "Add from Email" (`public.scan_usage`, `take_scan_slot()`). Already applied to the live project |
| `supabase/functions/scan-bill/index.ts` | The "Add from Email" server function: checks the person is signed in, enforces a daily limit, sends pasted text or pictures to Claude (Anthropic API), and returns the bills it found. Deployed to the live project |
| `supabase/email-template.html` | The sign-in email text; paste into both "Confirm sign up" and "Magic Link" templates in Supabase |
| `manifest.webmanifest`, `icon-*.png` | Home Screen app name and icon |
| `tests/` | Automated tests (see below) |

## How it works

- **Sign-in:** `signInWithOtp({email})`, then `verifyOtp({email, token, type:'email'})`. No redirects, so it works from a Home Screen app. Both email templates must contain `{{ .Token }}`.
- **Data:** every person's bills, name and settings are rows in `public.docs (user_id, id, data jsonb)`. Row Level Security lets each signed-in person read and change only their own rows; signed-out visitors get nothing. Bills have ids like `b<time><random>`, the name is the `profile` row, and `reminders` is reserved for reminder settings.
- **`makeStore(sb, uid)`** (near the bottom of `index.html`) is a small wrapper with `doc(id).set / update / delete` and `onSnapshot`. Saves show on screen immediately and are rolled back, with a message, if the server refuses them. The list refreshes when the page comes back to the foreground or the phone comes back online.
- **Screens:** `S.mode` is `loading`, `db` (signed in), `local` (no config, saves on this device only) or `auth` (sign-in screen). `showAuth()` clears all in-memory state and the remembered name, so a second person on the same phone never sees the first person's bills.
- **Sign out** uses `{scope:'local'}` on purpose; the default would sign the person out of every device.
- **Add from Email:** the bottom-bar button (signed-in people only) opens a sheet to paste an email, choose screenshots, or take a photo (a file input with `capture="environment"`, so iPhones open the camera). Pictures are shrunk in the browser (1600 px, JPEG) before upload. The page calls `sb.functions.invoke('scan-bill', ...)`; the function returns `{bills:[{kind,name,amount,date,repeat}]}` and the page reuses `validateExtracted()` and `mergeFound()` (the same code that handles dates, receipts, statements and "already in your list") to build a review list. Nothing is added until the person ticks bills and taps Add, and the pasted text and pictures are dropped when the sheet closes. **The Anthropic key never touches the page:** it is the Supabase Edge Function secret `ANTHROPIC_API_KEY` (Dashboard, Edge Functions, Secrets). Optional secrets: `SCAN_MODEL` (default `claude-haiku-5-5`), `SCAN_DAILY_PER_PERSON` (default 15), `SCAN_DAILY_TOTAL` (default 300). Set a monthly spend limit in the Anthropic console too. Without the key the button still shows and says "Not available yet".
- **Language (English / Spanish):** a globe button on the sign-in screen and next to the date switches the whole page. The choice is kept on the phone (`localStorage` key `mybills.lang`); the first visit follows the phone's first language (`navigator.languages[0]`, Spanish if it starts with `es`). Text written in the HTML carries its Spanish in `data-es` (placeholders: `data-es-ph`) and `applyStatic()` swaps it; text written by code uses `pt(english, spanish)`, and text that sits in the page and has to follow a language change uses `pair(el, english, spanish)`. Bill names and everything stored in Supabase are never translated. To change a word, search the file for the English text and edit the Spanish next to it. The hidden Find-in-Email screens (`scan-*`) are still English-only because the website never shows them.
- **Costa Rican Spanish:** the Spanish uses the words people use in Costa Rica: **facturas** (not "cuentas"), *Agregar una factura*, *Por pagar*, *Vencidas*, *Próximos 7 días*, *Cerrar sesión*, *Ajustes*, *correo*, *celular*, and the example bills *Luz* (ICE/CNFL), *Agua* (AyA), *Internet*, *Teléfono*, *Alquiler*. People are addressed as *usted*. Dates and numbers follow `es-CR`: `jue, 5 nov`, `₡24 750` (a space between thousands), `₡18 500,50` (decimal comma).
- **Currency (dollars / colones):** a small `₡` / `$` button next to the language button (and *Settings* at the bottom of the list) switches the list between US dollars and Costa Rican colones. It is saved in the `profile` row (`currency: 'USD' | 'CRC'`), so it follows the person to every phone. A new account starts in colones if the phone's language is Costa Rican Spanish (`es-CR`), otherwise dollars. Switching only changes the symbol and formatting: **amounts already entered are not converted**. Colones with no cents show without decimals (`₡24 750`). `setLocale(lang, currency)` in the pure block builds the formatters; `parseAmount` accepts `₡`, `¢` and `$`, and in colones `25.000` means twenty-five thousand. When a pasted email is in a different currency than the list (a dollar bill in a colones list), the bill is offered with the amount left empty and a note with the original amount, so nothing is silently mixed up. The scan function receives `currency` and reads amounts accordingly.
- **Bill icons:** `billKind(name)` (pure block) looks at the bill's name (English or Spanish, accents ignored) and picks a kind: water (*agua, AyA*), electricity (*luz, electricidad, ICE, CNFL*), internet and wifi (*internet, wifi, fibra, Telecable, Racsa...*), phone (*teléfono, celular, Kölbi, Claro, Movistar, Tigo...*), gas, trash (*basura*), rent and mortgage, streaming, credit card, car, insurance, health, loans. The row gets a small colored tile with a white drawing (`.bico`, inline SVG from the `ICONS` map; decorative, `aria-hidden`). Anything else gets no icon. To add one, add a rule to `KIND_RULES`, a drawing to `ICONS` and a color `.k-<kind>` in the CSS.
- **Staying signed in:** supabase-js saves the login in `localStorage` (`sb-<project>-auth-token`) and renews it by itself, so a person signs in with a code once and is not asked again. On top of that the page never sends a person with a saved login back to the code screen just because the phone had no signal when the page opened: `boot()` keeps the saved login, shows the loading list, and retries every few seconds (`recover()`); only a refusal from the server (the login was revoked or expired for good) clears it and shows sign-in. A code request that is waiting for its code is remembered for 55 minutes (`mybills.pendingCode`), so leaving the page to open the email app and coming back lands on the code box, not on the email box. On iPhone, Safari clears a website's saved data after about 7 days without a visit; the page shows a one-time hint (*Share, Add to Home Screen*) on iPhone Safari, because a Home Screen app is exempt (it keeps its own saved login, so she signs in once more inside it).
- **Supabase setting to change by hand (Dashboard, Authentication, Sessions, Advanced Settings):** turn **off** "Detect and revoke potentially compromised refresh tokens". With it on, a phone that opens the page twice at once (for example Home Screen app and Safari, or a slow connection) can have its login revoked and be asked for a code again. If your plan shows "Time-box user sessions" or "Inactivity timeout", leave them off, and leave the JWT expiry at its default.
- Amounts accept a decimal comma (`94,50` and `1.234,56` read as 94.50 and 1234.56), because that is how Spanish speakers write them. `1,200` still means twelve hundred, and `1.200` means twelve hundred only when reading Spanish or colones.
- Supabase JS 2.118.0 is loaded from jsDelivr.

## Tests

```
npm i jsdom @electric-sql/pglite playwright
node tests/site-test.js index.html jsdom             # sign-in, sync, sign-out, errors, Spanish, colones, icons, staying signed in, with a fake Supabase
node tests/rls-test.mjs supabase/schema.sql         # real Postgres (PGlite): who can read or change which rows, and the scan limits
node tests/function-test.mjs supabase/functions/scan-bill/index.ts   # the scan function, with stand-ins for Supabase and Anthropic
node tests/scan-e2e.js . shots es-CR                # Add from Email in real Chromium: picture shrinking, camera input, phone layout
npm i @supabase/supabase-js@2.118.0 && node tests/e2e-real-library.js . node_modules/@supabase/supabase-js/dist/umd/supabase.js
LONG=1 node tests/e2e-real-library.js . node_modules/@supabase/supabase-js/dist/umd/supabase.js   # adds a ~2 minute run that waits out the library's own 60 s retry pause with the phone offline
mkdir shots && node tests/shots-site.js . shots es-CR CRC 390   # screenshots of sign-in, list, edit and settings screens: locale (en-US or es-CR), currency (USD or CRC), width in pixels (try 320)
```

## Not built yet

1. **Reminder emails.** Plan: a Supabase Edge Function on a daily schedule (`pg_cron`) that reads `reminders` and unpaid bills with the service role key (server side only) and sends mail through an email service. Then set `FEATURES.reminders = true` in `index.html` (the Reminders screen already exists but is hidden).
2. **Sending sign-in codes at scale.** Sign-in emails now go out through Gmail SMTP (an app password), which allows roughly 500 recipients a day, and Supabase starts custom SMTP at 30 emails an hour. For more, use an email service with your own domain (for example Resend) under Authentication, Emails, SMTP Settings.
3. **Finding bills in Gmail automatically.** "Add from Email" is paste, screenshot or photo. Reading a person's Gmail directly would need Google sign-in and Google's app review for sensitive scopes.
4. Offline support, live sync between devices, delete my account.

## Gotchas

- Free Supabase projects pause after a week with no activity (Restore them from the dashboard).
- GitHub Pages on the free plan needs a public repository.
- Supabase reports "expired or invalid" for a mistyped code too, so the app does not say which it was.
- Edge Functions that are called with a signed-in person's token keep `verify_jwt` on; the function also looks the person up itself (`auth.getUser`) so it can count their daily reads.
- Don't call Supabase from inside an `onAuthStateChange` callback without deferring it (the app uses `setTimeout`).
- Never edit the colones and dollars rows of an existing list to "convert" them with a fixed rate in code: the rate changes daily and the person would not see it. If conversion is wanted later, make it an explicit button that shows the rate used.
