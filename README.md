# Bills

A simple, phone-first bill tracker. Sign in with your email (a 6-digit code, no password), keep your own private list of bills, and tap the circle when one is paid. It installs on an iPhone Home Screen (Share, then Add to Home Screen).

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
- **Language (English / Spanish):** a globe button on the sign-in screen and next to the date switches the whole page. The choice is kept on the phone (`localStorage` key `mybills.lang`); the first visit follows the phone's first language (`navigator.languages[0]`, Spanish if it starts with `es`). Text written in the HTML carries its Spanish in `data-es` (placeholders: `data-es-ph`) and `applyStatic()` swaps it; text written by code uses `pt(english, spanish)`, and text that sits in the page and has to follow a language change uses `pair(el, english, spanish)`. `setLocale()` rebuilds the number and date formatters (`es-US`: dollars stay dollars). Bill names and everything stored in Supabase are never translated. To change a word, search the file for the English text and edit the Spanish next to it. The hidden Find-in-Email screens (`scan-*`) are still English-only because the website never shows them.
- Amounts accept a decimal comma (`94,50` and `1.234,56` read as 94.50 and 1234.56), because that is how Spanish speakers write them. `1,200` still means twelve hundred, and `1.200` means twelve hundred only when reading Spanish.
- Supabase JS 2.118.0 is loaded from jsDelivr.

## Tests

```
npm i jsdom @electric-sql/pglite playwright
node tests/site-test.js index.html jsdom             # sign-in, sync, sign-out, errors, Spanish, with a fake Supabase
node tests/rls-test.mjs supabase/schema.sql         # real Postgres (PGlite): who can read or change which rows, and the scan limits
node tests/function-test.mjs supabase/functions/scan-bill/index.ts   # the scan function, with stand-ins for Supabase and Anthropic
node tests/scan-e2e.js . shots es-US                # Add from Email in real Chromium: picture shrinking, camera input, phone layout
npm i @supabase/supabase-js@2.118.0 && node tests/e2e-real-library.js . node_modules/@supabase/supabase-js/dist/umd/supabase.js
mkdir shots && node tests/shots-site.js . shots es-US   # screenshots of sign-in, list and edit screens (second argument: en-US or es-US)
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
