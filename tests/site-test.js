// Tests for the website version: email-code sign-in, per-person synced lists, sign-out, errors.
// A fake Supabase stands in for the real one (same calls the page makes). Made-up people and bills only.
// Usage: node site-test.js <index.html> <jsdom module path>
const fs = require('fs');
const { JSDOM } = require(process.argv[3]);
const html = fs.readFileSync(process.argv[2], 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (cond, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (cond()) return true; } catch (e) {} await sleep(20); } return false; };
let failed = false;
const ok = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' -> ' + extra : '')); if (!cond) failed = true; };

// ---------- fake Supabase backend (shared by every "page load", like the real server)
function makeBackend() {
  const b = {
    rows: [], session: null, codes: {}, log: [], failWrites: false, sendError: null, listeners: [], sessionFails: 0, sessionError: null, anonFallback: false,
    fnCalls: [], fnReply: { data: { bills: [] }, error: null }, fnGate: null,
    userId: email => 'u_' + email.replace(/[^a-z]/g, ''),
    client() {
      const auth = {
        getSession: async () => {
          if (b.sessionFails > 0) { b.sessionFails--; return { data: { session: null }, error: b.sessionError || { name: 'AuthRetryableFetchError', message: 'Failed to fetch', status: 0 } }; }
          return { data: { session: b.session }, error: null };
        },
        onAuthStateChange: cb => { b.listeners.push(cb); return { data: { subscription: { unsubscribe() {} } } }; },
        signInWithOtp: async arg => {
          b.log.push(['signInWithOtp', arg.email, JSON.stringify(arg.options)]);
          if (b.sendError) return { data: {}, error: b.sendError };
          b.codes[arg.email] = '123456';
          return { data: {}, error: null };
        },
        verifyOtp: async arg => {
          b.log.push(['verifyOtp', arg.email, arg.token, arg.type]);
          if (arg.type !== 'email' || b.codes[arg.email] !== arg.token) return { data: { session: null, user: null }, error: { status: 403, code: 'otp_expired', message: 'Token has expired or is invalid' } };
          b.session = { user: { id: b.userId(arg.email), email: arg.email } };
          return { data: { session: b.session, user: b.session.user }, error: null };
        },
        signOut: async opts => { b.log.push(['signOut', JSON.stringify(opts)]); b.session = null; b.listeners.forEach(cb => cb('SIGNED_OUT', null)); return { error: null }; },
      };
      const from = table => {
        if (table !== 'docs') throw new Error('unexpected table ' + table);
        const q = { op: 'select', eq: [] };
        const api = {
          select() { return api; },
          eq(c, v) { q.eq.push([c, v]); return api; },
          upsert(row, opts) { q.op = 'upsert'; q.row = row; q.opts = opts; return api; },
          delete() { q.op = 'delete'; return api; },
          then(res, rej) { return run().then(res, rej); },
        };
        async function run() {
          await sleep(5);
          const me = b.session && b.session.user.id;
          if (!me && b.anonFallback && q.op === 'select') return { data: [], error: null };   // what the real service does when a request goes out without a login
          if (!me) return { data: null, error: { message: 'permission denied for table docs' } };
          const matches = r => r.user_id === me && q.eq.every(([c, v]) => r[c] === v);
          if (q.op === 'select') return { data: b.rows.filter(matches).map(r => ({ id: r.id, data: JSON.parse(JSON.stringify(r.data)) })), error: null };
          if (b.failWrites) return { data: null, error: { message: 'boom' } };
          if (q.op === 'upsert') {
            if (q.row.user_id !== me) return { data: null, error: { message: 'new row violates row-level security policy for table "docs"' } };
            b.log.push(['upsert', q.row.user_id, q.row.id, JSON.stringify(q.opts)]);
            const i = b.rows.findIndex(r => r.user_id === me && r.id === q.row.id);
            const row = { user_id: q.row.user_id, id: q.row.id, data: JSON.parse(JSON.stringify(q.row.data)) };
            if (i >= 0) b.rows[i] = row; else b.rows.push(row);
            return { data: null, error: null };
          }
          if (q.op === 'delete') {
            b.log.push(['delete', q.eq.map(e => e.join('=')).join('&')]);
            b.rows = b.rows.filter(r => !matches(r));
            return { data: null, error: null };
          }
        }
        return api;
      };
      const functions = {
        invoke: async (name, opts) => {
          b.fnCalls.push({ name, body: JSON.parse(JSON.stringify(opts.body)), signedIn: !!b.session });
          if (b.fnGate) await b.fnGate;
          await sleep(5);
          return typeof b.fnReply === 'function' ? b.fnReply(opts.body) : b.fnReply;
        },
      };
      return { auth, from, functions };
    },
  };
  return b;
}

function open({ backend, configured = true, ls = {}, noLib = false, langs = null, ua = null, standalone = false }) {
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', url: 'https://example.com/', pretendToBeVisual: true,
    beforeParse(w) {
      if (ua) Object.defineProperty(w.navigator, 'userAgent', { value: ua, configurable: true });
      if (standalone) Object.defineProperty(w.navigator, 'standalone', { value: true, configurable: true });
      if (langs) Object.defineProperty(w.navigator, 'languages', { value: langs, configurable: true });
      Object.entries(ls).forEach(([k, v]) => w.localStorage.setItem(k, v));
      if (configured) w.BILLS_CONFIG = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_KEY: 'sb_publishable_test' };
      if (configured && !noLib) w.supabase = { createClient: () => backend.client() };
    },
  });
  const w = dom.window, doc = w.document, $ = id => doc.getElementById(id);
  const submit = id => $(id).dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  const lsAll = () => { const o = {}; for (let i = 0; i < w.localStorage.length; i++) { const k = w.localStorage.key(i); o[k] = w.localStorage.getItem(k); } return o; };
  const signIn = async email => {
    $('a-email').value = email; submit('auth-email-form');
    await until(() => !$('auth-code-form').hidden);
    $('a-code').value = '123456'; submit('auth-code-form');
    return until(() => $('auth').hidden && !doc.querySelector('.app').hidden);
  };
  const fillBill = (name, amount, due) => {
    $('add-btn').click();
    $('f-name').value = name; $('f-amount').value = amount; $('f-due').value = due; $('f-repeat').value = 'monthly';
    submit('bill-form');
  };
  const visible = id => !$(id).hidden;
  return { w, doc, $, submit, lsAll, signIn, fillBill, visible, close: () => w.close() };
}

(async () => {
  // ---------- A. not connected to Supabase yet (config.js empty): works on this device only, no sign-in screen
  let p = open({ backend: makeBackend(), configured: false });
  ok('A: no sign-in screen when Supabase is not set up', await until(() => p.$('title-text').textContent === 'My Bills' || !p.$('name-scrim').hidden) && p.$('auth').hidden && !p.doc.querySelector('.app').hidden);
  p.fillBill('Phone', '65', '2026-12-09');
  ok('A: bill saved on this device', await until(() => /Phone/.test(p.$('content').textContent)) && JSON.parse(p.lsAll()['mybills.v1']).some(b => b.name === 'Phone'));
  ok('A: footer says this phone only', /saved on this phone only/.test(p.$('content').textContent));
  p.close();

  // ---------- B. configured but the Supabase library did not load
  p = open({ backend: makeBackend(), noLib: true });
  ok('B: sign-in screen with a clear message', await until(() => !p.$('auth').hidden) && /Can.t reach the sign-in service/.test(p.$('a-error').textContent) && !p.$('a-error').hidden);
  p.close();

  // ---------- C. first visit: sign-in screen, then the whole flow
  const backend = makeBackend();
  p = open({ backend });
  ok('C: signed out => sign-in screen shown', await until(() => !p.$('auth').hidden));
  ok('C: app and Add button are hidden', p.doc.querySelector('.app').hidden && p.doc.querySelector('.bar').hidden);
  ok('C: email step is showing, code step is not', !p.$('auth-email-form').hidden && p.$('auth-code-form').hidden);
  ok('C: the app icon is drawn', /<svg/.test(p.$('auth-icon').innerHTML));

  p.$('a-email').value = 'not-an-email'; p.submit('auth-email-form');
  ok('C: bad email => message, nothing sent', !p.$('a-error').hidden && /name@example\.com/.test(p.$('a-error').textContent) && !backend.log.some(l => l[0] === 'signInWithOtp'));

  backend.sendError = { status: 429, code: 'over_email_send_rate_limit', message: 'email rate limit exceeded' };
  p.$('a-email').value = 'Maria@Example.test'; p.submit('auth-email-form');
  ok('C: rate limit => friendly message', await until(() => /Too many tries/.test(p.$('a-error').textContent)), p.$('a-error').textContent);
  backend.sendError = { status: 400, message: 'Email address not authorized' };
  p.submit('auth-email-form');
  ok('C: "not authorized" => tells her to ask the site owner', await until(() => /can.t sign in yet/.test(p.$('a-error').textContent)), p.$('a-error').textContent);
  backend.sendError = { status: 500, message: 'smtp exploded' };
  p.submit('auth-email-form');
  ok('C: other failure => generic message', await until(() => /couldn.t send the code/.test(p.$('a-error').textContent)), p.$('a-error').textContent);
  ok('C: button usable again after failures', !p.$('a-send').disabled && p.$('a-send').textContent === 'Email Me a Code');

  backend.sendError = null;
  p.submit('auth-email-form');
  ok('C: valid email => code step', await until(() => !p.$('auth-code-form').hidden && p.$('auth-email-form').hidden));
  const sent = backend.log.filter(l => l[0] === 'signInWithOtp').pop();
  ok('C: email lower-cased, signup allowed', sent[1] === 'maria@example.test' && JSON.parse(sent[2]).shouldCreateUser === true, sent.join(' '));
  ok('C: page says where the code went', /maria@example\.test/.test(p.$('a-sent').textContent) && /6-digit/.test(p.$('a-sent').textContent));
  ok('C: resend is on a 60-second wait', p.$('a-resend').disabled && /\(60\)/.test(p.$('a-resend').textContent), p.$('a-resend').textContent);
  ok('C: code box asks for the one-time code', p.$('a-code').getAttribute('autocomplete') === 'one-time-code' && p.$('a-code').getAttribute('inputmode') === 'numeric');

  p.$('a-code').value = '12'; p.submit('auth-code-form');
  ok('C: short code => asks for 6 digits', !p.$('a-code-error').hidden && /6-digit/.test(p.$('a-code-error').textContent));
  p.$('a-code').value = '999999'; p.submit('auth-code-form');
  ok('C: wrong code => stays on the code step with a message', await until(() => /didn.t work/.test(p.$('a-code-error').textContent)) && !p.$('auth-code-form').hidden);
  ok('C: wrong code did not sign in', !backend.session && !p.$('auth').hidden);
  p.$('a-change').click();
  ok('C: "different email" goes back', !p.$('auth-email-form').hidden && p.$('auth-code-form').hidden);
  p.$('a-email').value = 'maria@example.test'; p.submit('auth-email-form');
  await until(() => !p.$('auth-code-form').hidden);
  p.$('a-code').value = ' 123 456 '; p.submit('auth-code-form');
  ok('C: right code (spaces ignored) => signed in, app visible', await until(() => p.$('auth').hidden && !p.doc.querySelector('.app').hidden && !p.doc.querySelector('.bar').hidden));
  const v = backend.log.filter(l => l[0] === 'verifyOtp').pop();
  ok('C: verified as type email with the clean code', v[1] === 'maria@example.test' && v[2] === '123456' && v[3] === 'email', v.join(' '));
  ok('C: first time => asks for her name', await until(() => !p.$('name-scrim').hidden));
  p.$('f-uname').value = 'Maria'; p.submit('name-form');
  ok('C: title uses her name', await until(() => p.$('title-text').textContent === 'Maria’s Bills'));
  const prof = () => backend.rows.find(r => r.user_id === 'u_mariaexampletest' && r.id === 'profile');
  ok('C: name saved to her account', await until(() => prof() && prof().data.name === 'Maria' && prof().data.asked === true));
  ok('C: empty state for a new account', /No bills yet/.test(p.$('content').textContent));
  ok('C: footer shows who is signed in, with Sign out', /Signed in as maria@example\.test/.test(p.$('content').textContent) && !!p.$('content').querySelector('[data-act="signout"]'));

  p.fillBill('Rent', '1200', '2026-12-01');
  ok('C: bill shows right away', await until(() => /Rent/.test(p.$('content').textContent)));
  const bill = () => backend.rows.find(r => r.user_id === 'u_mariaexampletest' && r.id !== 'profile');
  ok('C: bill saved in her account (user_id set, upsert on user_id,id)', await until(() => bill() && bill().data.name === 'Rent' && bill().data.amount === 1200 && bill().data.due === '2026-12-01'));
  const up = backend.log.filter(l => l[0] === 'upsert' && l[2] !== 'profile').pop();
  ok('C: upsert targets the (user_id,id) key', up && up[1] === 'u_mariaexampletest' && JSON.parse(up[3]).onConflict === 'user_id,id', up && up.join(' '));
  ok('C: stored bill has no id field inside data and no secrets', bill() && !('id' in bill().data) && Object.keys(bill().data).sort().join() === 'amount,anchorDay,due,example,lastPaid,name,paid,repeat');

  // edit then delete
  p.$('content').querySelector('[data-act="edit"]').click();
  p.$('f-amount').value = '1250'; p.submit('bill-form');
  ok('C: edit saved', await until(() => bill() && bill().data.amount === 1250));
  p.$('content').querySelector('[data-act="edit"]').click();
  p.$('del-start').click(); p.$('del-yes').click();
  ok('C: delete removes only that row', await until(() => !bill()) && !!prof());
  ok('C: delete targeted her row only', backend.log.some(l => l[0] === 'delete' && /user_id=u_mariaexampletest/.test(l[1]) && /id=b/.test(l[1])));
  p.fillBill('Water', '30', '2026-12-10');
  await until(() => /Water/.test(p.$('content').textContent) && bill());
  p.close();

  // ---------- D. coming back: already signed in
  p = open({ backend });
  ok('D: straight in, no sign-in screen', await until(() => /Water/.test(p.$('content').textContent)) && p.$('auth').hidden);
  ok('D: her name is in the title and she is not asked again', p.$('title-text').textContent === 'Maria’s Bills' && p.$('name-scrim').hidden);
  await sleep(500);
  ok('D: still not asked for a name', p.$('name-scrim').hidden);

  // ---------- E. sign out, then a different person on the same phone
  const lsBefore = p.lsAll();
  p.$('content').querySelector('[data-act="signout"]').click();
  ok('E: sign out => sign-in screen', await until(() => !p.$('auth').hidden && p.doc.querySelector('.app').hidden));
  ok('E: signed out on this phone only (not every device)', backend.log.some(l => l[0] === 'signOut' && JSON.parse(l[1]).scope === 'local'), JSON.stringify(backend.log.filter(l => l[0] === 'signOut')));
  ok('E: her bills are gone from the page', !/Water|Rent/.test(p.doc.body.textContent.replace(/\s+/g, ' ').replace(/Email Me a Code/, '')) || p.$('content').innerHTML === '');
  ok('E: remembered name wiped from this phone', (p.lsAll()['mybills.lastName'] || '') === '', p.lsAll()['mybills.lastName']);
  await p.signIn('omar@example.test');
  ok('E: Omar sees an empty list, not Maria’s bills', await until(() => /No bills yet/.test(p.$('content').textContent)) && !/Water/.test(p.$('content').textContent));
  ok('E: Omar is asked for his name, title is not Maria’s', await until(() => !p.$('name-scrim').hidden) && !/Maria/.test(p.$('title-text').textContent), p.$('title-text').textContent);
  p.$('name-cancel').click();
  ok('E: skipping the name gives "My Bills"', await until(() => p.$('title-text').textContent === 'My Bills'));
  ok('E: Maria’s rows untouched', backend.rows.filter(r => r.user_id === 'u_mariaexampletest').length >= 2);

  // ---------- F. a failed save is rolled back and explained
  p.fillBill('Gym', '20', '2026-12-03');
  await until(() => /Gym/.test(p.$('content').textContent));
  backend.failWrites = true;
  p.fillBill('Doomed', '5', '2026-12-04');
  ok('F: failed save => bill disappears again', await until(() => !/Doomed/.test(p.$('content').textContent) && /Gym/.test(p.$('content').textContent)));
  ok('F: and a message explains', await until(() => /Couldn.t save that/.test(p.$('toast').textContent)), p.$('toast').textContent);
  backend.failWrites = false;

  // ---------- G. another device added a bill: it shows up when this page is opened again
  backend.rows.push({ user_id: 'u_omarexampletest', id: 'bfromipad', data: { name: 'From iPad', amount: 9, due: '2026-12-20', repeat: 'monthly', anchorDay: 20, paid: false, lastPaid: null, example: false } });
  const realNow = Date.now();
  p.w.Date.now = () => realNow + 60000;
  p.doc.dispatchEvent(new p.w.Event('visibilitychange'));
  ok('G: coming back to the page refreshes the list', await until(() => /From iPad/.test(p.$('content').textContent)));

  // ---------- H. login expires or is revoked somewhere else
  backend.session = null;
  backend.listeners.forEach(cb => cb('SIGNED_OUT', null));
  ok('H: session ended => back to sign-in', await until(() => !p.$('auth').hidden && p.doc.querySelector('.app').hidden));
  p.close();

  // ---------- I. bills typed in before the site was connected can be moved into the account
  const b2 = makeBackend();
  const oldBills = [{ id: 'bold1', name: 'Old Phone', amount: 40, due: '2026-12-05', repeat: 'monthly', anchorDay: 5, paid: false, lastPaid: null, example: false },
                    { id: 'bold2', name: 'Old Power', amount: 80, due: '2026-12-06', repeat: 'monthly', anchorDay: 6, paid: false, lastPaid: null, example: false }];
  p = open({ backend: b2, ls: { 'mybills.v1': JSON.stringify(oldBills), 'mybills.profile.v1': JSON.stringify({ name: 'Ana', asked: true }) } });
  await until(() => !p.$('auth').hidden);
  await p.signIn('ana@example.test');
  ok('I: banner offers to move this phone’s bills', await until(() => /Found 2 bills saved on this phone/.test(p.$('content').textContent)));
  p.$('content').querySelector('[data-act="import"]').click();
  ok('I: both bills copied into her account', await until(() => b2.rows.filter(r => r.user_id === 'u_anaexampletest' && /^bold/.test(r.id)).length === 2));
  ok('I: device copy removed afterwards', await until(() => !p.lsAll()['mybills.v1']));
  p.close();

  // ---------- J. Spanish: auto-detect, the language button, remembered choice, and no English left behind
  const LEFT = /\b(Overdue|Due (today|tomorrow|in)|Next 7 days|Later|Paid|Add a Bill|Sign out|Signed in|bills?\b|Nothing due|caught up|Never|Every (week|month|year|2 weeks)|Cancel|Save|Delete|Email Me|Sign In|Undo|Left this month)\b/;
  const b3 = makeBackend();
  p = open({ backend: b3, langs: ['es-US', 'en'] });
  ok('J: phone set to Spanish => sign-in screen opens in Spanish', await until(() => !p.$('auth').hidden) && /Enviarme un código/.test(p.$('a-send').textContent) && p.doc.documentElement.lang === 'es', p.$('a-send').textContent);
  ok('J: button names the other language', /English/.test(p.doc.querySelector('#auth .lang-btn').textContent));
  ok('J: placeholder is Spanish', p.$('a-email').getAttribute('placeholder') === 'nombre@ejemplo.com');
  ok('J: nothing English left on the sign-in screen', !/Email Me|Sign In|different email/.test(p.$('auth').textContent), p.$('auth').textContent.replace(/\s+/g, ' ').slice(0, 200));
  p.$('a-email').value = 'nope'; p.submit('auth-email-form');
  ok('J: bad email error is Spanish', /Escriba su correo/.test(p.$('a-error').textContent), p.$('a-error').textContent);
  p.doc.querySelector('#auth .lang-btn').click();
  ok('J: tapping the button switches the sign-in screen to English, error included', /Email Me a Code/.test(p.$('a-send').textContent) && /Enter your email address/.test(p.$('a-error').textContent) && p.doc.documentElement.lang === 'en');
  ok('J: choice remembered on this phone', p.lsAll()['mybills.lang'] === 'en');
  p.doc.querySelector('#auth .lang-btn').click();
  ok('J: and back to Spanish', /Escriba su correo/.test(p.$('a-error').textContent) && p.lsAll()['mybills.lang'] === 'es');
  p.$('a-email').value = 'sofia@example.test'; p.submit('auth-email-form');
  await until(() => !p.$('auth-code-form').hidden);
  ok('J: code step: sent text and resend countdown in Spanish', /Enviamos un código de 6 dígitos a sofia@example\.test/.test(p.$('a-sent').textContent) && /Enviar un código nuevo \(\d+\)/.test(p.$('a-resend').textContent), p.$('a-resend').textContent);
  p.$('a-code').value = '000000'; p.submit('auth-code-form');
  ok('J: wrong code message is Spanish', await until(() => /Ese código no funcionó/.test(p.$('a-code-error').textContent)), p.$('a-code-error').textContent);
  p.$('a-code').value = '123456'; p.submit('auth-code-form');
  await until(() => p.$('auth').hidden && !p.doc.querySelector('.app').hidden);
  ok('J: signed in => asks for her name in Spanish', await until(() => !p.$('name-scrim').hidden) && /Ajustes/.test(p.$('name-title').textContent));
  p.$('f-uname').value = 'Sofía'; p.submit('name-form');
  ok('J: title reads “Facturas de Sofía”', await until(() => p.$('title-text').textContent === 'Facturas de Sofía'), p.$('title-text').textContent);
  ok('J: tab/home-screen name is Spanish', p.doc.title === 'Facturas');
  ok('J: empty state in Spanish', /Aún no hay facturas/.test(p.$('content').textContent) && /Agregar una factura/.test(p.$('add-btn').textContent));
  const today = new Date(), ymdOf = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const plus = n => { const d = new Date(); d.setDate(d.getDate() + n); return ymdOf(d); };
  p.fillBill('Luz', 'abc', plus(2));
  ok('J: a bad amount is rejected with a Spanish message', await until(() => !p.$('f-error').hidden) && /Escriba el monto con números/.test(p.$('f-error').textContent), p.$('f-error').textContent);
  p.$('f-amount').value = '94,50'; p.submit('bill-form');   // decimal comma, as written in Costa Rica
  ok('J: bill saved (Spanish), shows “Vence en 2 días” and the repeat label', await until(() => /Luz/.test(p.$('content').textContent)) && /Vence en 2 días/.test(p.$('content').textContent) && /Mensual/.test(p.$('content').textContent), p.$('content').textContent.replace(/\s+/g, ' '));
  ok('J: “94,50” was read as $94.50 (not $9,450)', /\$94,50/.test(p.$('content').textContent) && !/\$9[^0-9]?450/.test(p.$('content').textContent) && b3.rows.some(r => r.data && r.data.name === 'Luz' && r.data.amount === 94.5), JSON.stringify(b3.rows.map(r => r.data && r.data.amount)));
  ok('J: group heading and counts in Spanish', /Próximos 7 días/.test(p.$('content').textContent) && /1 factura(?!s)/.test(p.$('content').textContent));
  ok('J: date line is capitalised Spanish', /^[A-ZÁÉÍÓÚ][a-záéíóú]+,? /.test(p.$('today-line').textContent), p.$('today-line').textContent);
  ok('J: header button names English', /English/.test(p.doc.querySelector('.date-row .lang-btn').textContent));
  const stored = b3.rows.find(r => r.data && r.data.name === 'Luz');
  ok('J: stored data has no language in it (names stay as typed)', stored && !/Vence|Mensual|días/.test(JSON.stringify(stored.data)), JSON.stringify(stored && stored.data));
  p.doc.querySelector('.date-row .lang-btn').click();
  ok('J: switching in the app flips the list to English at once', /Due in 2 days/.test(p.$('content').textContent) && /Monthly/.test(p.$('content').textContent) && /Add a Bill/.test(p.$('add-btn').textContent) && p.$('title-text').textContent === 'Sofía’s Bills', p.$('title-text').textContent);
  p.doc.querySelector('.date-row .lang-btn').click();
  ok('J: and back; nothing English left in the list screen', !LEFT.test(p.$('content').textContent.replace(/Luz|Streaming/g, '')) && !LEFT.test(p.$('add-btn').textContent) , p.$('content').textContent.replace(/\s+/g, ' '));
  // edit sheet + delete confirm in Spanish
  p.$('content').querySelector('[data-act="edit"]').click();
  await until(() => !p.$('bill-scrim').hidden);
  ok('J: edit sheet in Spanish (title, hint, repeat options)', /Editar factura/.test(p.$('bill-title').textContent) && /¿No sabe el monto exacto\?/.test(p.$('f-hint').textContent) && /Cada mes/.test(p.$('f-repeat').textContent), p.$('bill-title').textContent + ' | ' + p.$('f-repeat').textContent);
  p.$('f-name').value = ''; p.submit('bill-form');
  ok('J: empty name error in Spanish', /Escriba un nombre/.test(p.$('f-error').textContent));
  p.$('del-start').click();
  ok('J: delete confirm in Spanish', /¿Eliminar esta factura\?/.test(p.$('bill-scrim').textContent) && /Conservar/.test(p.$('del-no').textContent));
  p.$('del-yes').click();
  ok('J: delete toast in Spanish with Undo → Deshacer', await until(() => /Se eliminó Luz/.test(p.doc.body.textContent) && /Deshacer/.test(p.doc.body.textContent)));
  p.close();

  // saved choice wins over the phone's language, and the next visit keeps it
  p = open({ backend: b3, langs: ['en-US'], ls: { 'mybills.lang': 'es' } });
  await until(() => p.$('auth').hidden && !p.doc.querySelector('.app').hidden);
  ok('J: saved Spanish beats an English phone', await until(() => /Agregar una factura/.test(p.$('add-btn').textContent)));
  ok('J: footer shows signed-in text in Spanish', await until(() => /Sesión iniciada como sofia@example\.test/.test(p.$('content').textContent) && /Cerrar sesión/.test(p.$('content').textContent)), p.$('content').textContent.replace(/\s+/g, ' ').slice(-200));
  p.close();
  p = open({ backend: makeBackend(), langs: ['es-MX'], ls: { 'mybills.lang': 'en' } });
  ok('J: saved English beats a Spanish phone', await until(() => !p.$('auth').hidden) && /Email Me a Code/.test(p.$('a-send').textContent));
  p.close();
  p = open({ backend: makeBackend(), langs: ['fr-FR', 'es'] });
  ok('J: only the phone’s first language counts (French first => English)', await until(() => !p.$('auth').hidden) && /Email Me a Code/.test(p.$('a-send').textContent));
  p.close();

  // examples + this-phone-only mode in Spanish
  p = open({ backend: makeBackend(), configured: false, langs: ['es'] });
  await until(() => !p.$('name-scrim').hidden || p.$('title-text').textContent);
  ok('J: local mode: footer + empty state in Spanish', await until(() => /guardan solo en este celular/.test(p.$('content').textContent)) && /Aún no hay facturas/.test(p.$('content').textContent));
  p.$('content').querySelector('[data-act="examples"]').click();
  ok('J: example bills are created in Spanish', await until(() => /Teléfono/.test(p.$('content').textContent)) && /Alquiler/.test(p.$('content').textContent) && /Estas son facturas de ejemplo/.test(p.$('content').textContent), p.$('content').textContent.replace(/\s+/g, ' ').slice(0, 300));
  ok('J: nothing English left (examples screen)', !LEFT.test(p.$('content').textContent.replace(/Streaming/g, '')), (p.$('content').textContent.match(LEFT) || [''])[0]);
  p.close();

  // ---------- K. Add from Email: paste text, Claude (a fake function here) reads it, the person reviews and adds
  const bK = makeBackend();
  p = open({ backend: bK });
  await until(() => !p.$('auth').hidden);
  ok('K: signed out: no Add from Email button', p.$('scan-btn').hidden);
  await p.signIn('kim@example.test');
  p.$('f-uname').value = 'Kim'; p.submit('name-form');
  await until(() => p.$('title-text').textContent === 'Kim’s Bills');
  ok('K: signed in: the button is there and says Add from Email', !p.$('scan-btn').hidden && /Add from Email/.test(p.$('scan-btn').textContent));
  ok('K: bottom bar leaves room for the toast', p.doc.body.classList.contains('two-bar'));
  const todayK = (() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })();
  const dayK = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const typeText = t => { p.$('scan-text').value = t; p.$('scan-text').dispatchEvent(new p.w.Event('input', { bubbles: true })); };
  const openScanSheet = () => { p.$('scan-btn').click(); };
  const resultText = () => p.$('scan-results').textContent.replace(/\s+/g, ' ');

  p.fillBill('Netflix', '15.99', dayK(8));   // a bill she already has
  await until(() => /Netflix/.test(p.$('content').textContent));
  openScanSheet();
  ok('K: sheet opens on the paste screen, nothing to send yet', !p.$('scan-scrim').hidden && !p.$('scan-intro').hidden && p.$('scan-go').disabled);
  ok('K: has paste box, screenshot and camera buttons; the camera input asks for the back camera', !!p.$('scan-text') && !!p.$('scan-pick') && !!p.$('scan-cam') && p.$('scan-cam-file').getAttribute('capture') === 'environment' && p.$('scan-file').getAttribute('accept') === 'image/*' && p.$('scan-file').multiple);
  typeText('short');
  ok('K: too little text keeps Find Bills off', p.$('scan-go').disabled);
  typeText('Your Acme Electric bill of $94.50 is due on ' + dayK(4) + '. Thanks for being a customer.');
  ok('K: enough text turns Find Bills on', !p.$('scan-go').disabled);
  bK.fnReply = { data: { bills: [
    { kind: 'bill', name: 'Acme Electric', amount: 94.5, date: dayK(4), repeat: 'monthly' },
    { kind: 'bill', name: 'Netflix', amount: 15.99, date: dayK(8), repeat: 'monthly' },
    { kind: 'receipt', name: 'Acme Water', amount: 40, date: dayK(-10), repeat: 'monthly' },
    { kind: 'statement', name: 'Acme Card', amount: null, date: null, repeat: 'monthly' },
  ] }, error: null };
  p.$('scan-go').click();
  ok('K: shows a reading screen while waiting', !p.$('scan-busy').hidden || !p.$('scan-results').hidden);
  ok('K: results appear', await until(() => !p.$('scan-results').hidden), p.$('scan-error').textContent);
  const call = bK.fnCalls[0];
  ok('K: called the scan-bill function as a signed-in person', bK.fnCalls.length === 1 && call.name === 'scan-bill' && call.signedIn);
  ok('K: sent the pasted text, today’s date and the language, and no pictures', /Acme Electric bill/.test(call.body.text) && call.body.today === todayK && call.body.lang === 'en' && Array.isArray(call.body.images) && call.body.images.length === 0, JSON.stringify(call.body).slice(0, 160));
  ok('K: says how many bills were found', /Found 4 bills\./.test(p.$('scan-found').textContent), p.$('scan-found').textContent);
  const boxes = () => [...p.$('scan-list').querySelectorAll('.scan-cb')];
  ok('K: four rows; the new bill is ticked', p.$('scan-list').children.length === 4 && /Acme Electric/.test(resultText()) && /\$94\.50/.test(resultText()));
  const rowOf = name => [...p.$('scan-list').children].find(li => li.textContent.includes(name));
  ok('K: a bill already in the list is flagged and not ticked; the others are ticked', /Already in your list/.test(rowOf('Netflix').textContent) && !rowOf('Netflix').querySelector('.scan-cb').checked && ['Acme Electric', 'Acme Water', 'Acme Card'].every(n => rowOf(n).querySelector('.scan-cb').checked), boxes().map(b => b.checked).join());
  ok('K: a payment receipt is turned into the next due date with a “check the date” note', /Based on your payment on/.test(resultText()) && /Check the date/.test(resultText()));
  ok('K: a statement with no date says so', /No due date is shown/.test(resultText()));
  ok('K: Add button counts the ticked bills', /^Add 3 Bills$/.test(p.$('scan-add').textContent), p.$('scan-add').textContent);
  boxes().forEach(b => { if (!b.checked) { b.checked = true; } }); p.$('scan-list').dispatchEvent(new p.w.Event('change', { bubbles: true }));
  ok('K: ticking more updates the count', /^Add 4 Bills$/.test(p.$('scan-add').textContent), p.$('scan-add').textContent);
  boxes().forEach(b => { b.checked = (b === rowOf('Acme Electric').querySelector('.scan-cb')); }); p.$('scan-list').dispatchEvent(new p.w.Event('change', { bubbles: true }));
  ok('K: unticking updates the count to one', /^Add 1 Bill$/.test(p.$('scan-add').textContent), p.$('scan-add').textContent);
  p.$('scan-add').click();
  ok('K: adding saves the bill to her account and closes the sheet', await until(() => bK.rows.some(r => r.data && r.data.name === 'Acme Electric' && r.data.amount === 94.5 && r.data.due === dayK(4) && r.data.repeat === 'monthly' && r.data.paid === false && r.user_id === 'u_kimexampletest')) && p.$('scan-scrim').hidden);
  ok('K: toast says how many were added', /Added 1 bill\./.test(p.$('toast').textContent), p.$('toast').textContent);
  ok('K: the new bill shows in the list', await until(() => /Acme Electric/.test(p.$('content').textContent)));
  openScanSheet();
  ok('K: reopening starts clean: the pasted email was not kept', p.$('scan-text').value === '' && !p.$('scan-intro').hidden && p.$('scan-go').disabled);
  p.$('scan-close').click();

  // errors: each one has a plain message, nothing is added, and Try Again / Back work
  const errReply = (name, code) => ({ data: null, error: { name, context: { json: async () => ({ error: code }) } } });
  const cases = [['limit', errReply('FunctionsHttpError', 'limit'), /That.s all for today/], ['busy', errReply('FunctionsHttpError', 'busy'), /Claude is busy/],
    ['not_configured', errReply('FunctionsHttpError', 'not_configured'), /Not available yet/], ['too_big', errReply('FunctionsHttpError', 'too_big'), /too much to read/],
    ['unauthorized', errReply('FunctionsHttpError', 'unauthorized'), /sign in again/], ['network', { data: null, error: { name: 'FunctionsFetchError', context: {} } }, /Couldn.t connect/],
    ['ai_failed', errReply('FunctionsHttpError', 'ai_failed'), /didn.t finish/], ['unreadable error body', { data: null, error: { name: 'FunctionsRelayError', context: { json: async () => { throw new Error('x'); } } } }, /didn.t finish/]];
  const rowsBefore = bK.rows.length;
  for (const [label, reply, re] of cases) {
    openScanSheet(); typeText('A long enough email text about a bill that is due soon.');
    bK.fnReply = reply; p.$('scan-go').click();
    ok('K: error “' + label + '” has its own message', await until(() => !p.$('scan-error').hidden) && re.test(p.$('scan-err-title').textContent), p.$('scan-err-title').textContent);
    if (label === 'limit') {
      p.$('scan-edit').click();
      ok('K: Back from an error returns to the paste screen with the text still there', !p.$('scan-intro').hidden && /long enough email/.test(p.$('scan-text').value));
      p.$('scan-go').click(); await until(() => !p.$('scan-error').hidden);
      bK.fnReply = { data: { bills: [{ kind: 'bill', name: 'Retry Co', amount: 5, date: dayK(3), repeat: 'none' }] }, error: null };
      p.$('scan-retry').click();
      ok('K: Try Again asks again and can succeed', await until(() => !p.$('scan-results').hidden) && /Retry Co/.test(resultText()));
    }
    p.$('scan-close').click();
  }
  ok('K: none of the errors added anything', bK.rows.length === rowsBefore);

  // nothing found
  openScanSheet(); typeText('Hi Kim, lunch on Friday? Let me know what works for you.');
  bK.fnReply = { data: { bills: [] }, error: null }; p.$('scan-go').click();
  ok('K: no bills => says so, no Add button', await until(() => !p.$('scan-results').hidden) && /No bills found\./.test(p.$('scan-found').textContent) && /didn.t see a bill/.test(p.$('scan-help').textContent) && p.$('scan-add').hidden && p.$('scan-list').hidden);
  p.$('scan-again').click();
  ok('K: Back returns to the paste screen with the text', !p.$('scan-intro').hidden && /lunch on Friday/.test(p.$('scan-text').value));
  bK.fnReply = { data: { bills: [{ kind: 'bill', name: 'Old Bill', amount: 10, date: dayK(-90), repeat: 'none' }] }, error: null }; p.$('scan-go').click();
  ok('K: a bill with a long-past date is not offered, and the message explains', await until(() => !p.$('scan-results').hidden) && /No bills found/.test(p.$('scan-found').textContent) && /older than about six weeks/.test(p.$('scan-help').textContent), p.$('scan-help').textContent);
  p.$('scan-close').click();

  // Stop while waiting: a late answer is ignored
  openScanSheet(); typeText('Another email about a bill that is due in two weeks.');
  let release; bK.fnGate = new Promise(r => { release = r; });
  bK.fnReply = { data: { bills: [{ kind: 'bill', name: 'Late Co', amount: 1, date: dayK(5), repeat: 'none' }] }, error: null };
  p.$('scan-go').click();
  ok('K: reading screen is up while waiting', await until(() => !p.$('scan-busy').hidden));
  p.$('scan-stop').click();
  ok('K: Stop goes back to the paste screen', !p.$('scan-intro').hidden && /Another email/.test(p.$('scan-text').value));
  release(); bK.fnGate = null; await sleep(60);
  ok('K: the late answer does not pop up', p.$('scan-results').hidden && p.$('scan-error').hidden && !p.$('scan-intro').hidden);
  p.$('scan-close').click();

  // double tap on Find Bills makes one call; a stray tap outside does not throw away the text
  bK.fnCalls.length = 0; openScanSheet(); typeText('Yet another bill email, due on the first of the month.');
  bK.fnReply = { data: { bills: [] }, error: null };
  p.$('scan-go').click(); p.$('scan-go').click();
  await until(() => !p.$('scan-results').hidden);
  ok('K: two quick taps ask only once', bK.fnCalls.length === 1, bK.fnCalls.length);
  p.$('scan-again').click();
  p.$('scan-scrim').dispatchEvent(new p.w.MouseEvent('click', { bubbles: true }));
  ok('K: tapping the dark area does not close the sheet while there is text', !p.$('scan-scrim').hidden);
  p.$('scan-close').click();
  ok('K: Close closes it', p.$('scan-scrim').hidden);
  openScanSheet(); p.$('scan-scrim').dispatchEvent(new p.w.MouseEvent('click', { bubbles: true }));
  ok('K: with nothing typed, tapping the dark area closes it', p.$('scan-scrim').hidden);

  // pictures that are not pictures
  openScanSheet();
  const notPic = new p.w.File(['hello'], 'notes.txt', { type: 'text/plain' });
  Object.defineProperty(p.$('scan-file'), 'files', { value: [notPic], configurable: true });
  p.$('scan-file').dispatchEvent(new p.w.Event('change'));
  ok('K: a non-picture is refused with a message', await until(() => !p.$('scan-input-error').hidden && /isn.t a picture/.test(p.$('scan-input-error').textContent)), p.$('scan-input-error').textContent);
  p.$('scan-close').click();

  // Spanish
  p.doc.querySelector('.date-row .lang-btn').click();
  ok('K: Spanish: the button says Agregar desde correo', /Agregar desde correo/.test(p.$('scan-btn').textContent));
  openScanSheet();
  ok('K: Spanish: sheet text', /Agregar desde correo/.test(p.$('scan-title').textContent) && /Elegir captura/.test(p.$('scan-pick').textContent) && /Tomar foto/.test(p.$('scan-cam').textContent) && /Buscar facturas/.test(p.$('scan-go').textContent) && /^Pegue aquí/.test(p.$('scan-text').getAttribute('placeholder')) && /Texto del correo/.test(p.doc.querySelector('label[for="scan-text"]').textContent));
  ok('K: Spanish: nothing English left on the paste screen', !/Paste|Choose|Take a|Find Bills|doesn.t keep|Close/.test(p.$('scan-sheet').textContent.replace(/\s+/g, ' ')), p.$('scan-sheet').textContent.replace(/\s+/g, ' ').slice(0, 300));
  typeText('Su recibo de Acme Electric por $94.50 vence el ' + dayK(4) + '.');
  bK.fnCalls.length = 0;
  bK.fnReply = { data: { bills: [{ kind: 'bill', name: 'Acme Electric', amount: 94.5, date: dayK(4), repeat: 'monthly' }, { kind: 'receipt', name: 'Acme Water', amount: 40, date: dayK(-10), repeat: 'monthly' }, { kind: 'bill', name: 'Acme Gas', amount: 30, date: dayK(5), repeat: 'none' }] }, error: null };
  p.$('scan-go').click();
  await until(() => !p.$('scan-results').hidden);
  ok('K: Spanish: the function is told the language', bK.fnCalls[0].body.lang === 'es');
  ok('K: Spanish: results in Spanish', /Se encontraron 3 facturas\./.test(p.$('scan-found').textContent) && /Ya está en su lista/.test(resultText()) && /Vence /.test(resultText()) && /Mensual/.test(resultText()) && /Según su pago del/.test(resultText()) && /Revise la fecha/.test(resultText()) && /^Agregar 2 facturas$/.test(p.$('scan-add').textContent), p.$('scan-found').textContent + ' | ' + p.$('scan-add').textContent);
  ok('K: Spanish: nothing English left on the results screen', !/\b(Due|Monthly|Found|Based on|Check the date|Add \d|Back)\b/.test(p.$('scan-results').textContent.replace(/\s+/g, ' ').replace(/Acme [A-Za-z]+/g, '')), p.$('scan-results').textContent.replace(/\s+/g, ' ').slice(0, 300));
  p.$('scan-add').click();
  ok('K: Spanish: toast', await until(() => /Se agregaron 2 facturas\./.test(p.$('toast').textContent)), p.$('toast').textContent);
  openScanSheet(); typeText('Texto de otro correo con una cuenta por pagar pronto.');
  bK.fnReply = errReply('FunctionsHttpError', 'limit'); p.$('scan-go').click();
  ok('K: Spanish: error text', await until(() => !p.$('scan-error').hidden) && /Eso es todo por hoy/.test(p.$('scan-err-title').textContent) && /Inténtelo mañana/.test(p.$('scan-err-body').textContent) && /Intentar de nuevo/.test(p.$('scan-retry').textContent));
  p.$('scan-close').click();
  p.close();

  // not available when the site has no Supabase (this-phone-only mode) or while loading
  p = open({ backend: makeBackend(), configured: false });
  await until(() => p.$('title-text').textContent);
  ok('K: this-phone-only mode: no Add from Email (it needs an account)', p.$('scan-btn').hidden && !p.doc.body.classList.contains('two-bar'));
  p.close();

  // ---------- L. the pure helpers: bill type for the icon, amounts in dollars and colones
  const pureSrc = html.split('/* ==PURE START== */')[1].split('/* ==PURE END== */')[0];
  const P = new Function(pureSrc + '\n;return {billKind,setLocale,money,parseAmount,validateExtracted,mergeFound};')();
  const KINDS = [['Wifi','internet'],['Wi-Fi Kölbi','internet'],['Internet','internet'],['Fibra óptica','internet'],['Starlink','internet'],['Xfinity','internet'],
    ['Kölbi','phone'],['Teléfono','phone'],['Movistar','phone'],['T-Mobile','phone'],['AT&T','phone'],['Verizon Wireless','phone'],['Celular de Ana','phone'],
    ['Luz','power'],['Electric','power'],['ICE','power'],['CNFL','power'],['Coopelesca','power'],['PSO','power'],['Electricidad','power'],
    ['Agua','water'],['AyA','water'],['Water','water'],['City of Tulsa','water'],
    ['Gas','gas'],['Oklahoma Natural Gas','gas'],['Gas natural','gas'],['Basura','trash'],['Trash','trash'],
    ['Netflix','tv'],['Cable','tv'],['Spotify','tv'],['Disney+','tv'],
    ['Alquiler','home'],['Rent','home'],['Hipoteca','home'],['Condominio','home'],
    ['Tarjeta BAC','card'],['Visa','card'],['Capital One','card'],
    ['Carro','car'],['Marchamo','car'],['Parqueo','car'],
    ['Seguro del carro','insurance'],['State Farm','insurance'],['INS','insurance'],['CCSS','insurance'],
    ['Dentista','health'],['Gimnasio','health'],['Préstamo personal','loan'],['Student Loan','loan'],
    ['Hacienda','bill'],['Mom','bill'],['','bill'],[null,'bill']];
  const wrongKinds = KINDS.filter(([n, k]) => P.billKind(n) !== k).map(([n, k]) => n + ' -> ' + P.billKind(n) + ' (wanted ' + k + ')');
  ok('L: bill type picks the right picture for water, electricity, internet, phone and more (English and Costa Rican names)', wrongKinds.length === 0, wrongKinds.join('; '));
  P.setLocale('es', 'CRC');
  const sp = v => P.money(v).replace(/\s/g, ' ');
  ok('L: colones in Costa Rican Spanish: ₡24 750, no cents when whole, cents when not', sp(24750) === '₡24 750' && sp(18500.5) === '₡18 500,50' && sp(1250000) === '₡1 250 000' && P.money(null) === '—', sp(24750) + ' | ' + sp(18500.5));
  P.setLocale('en', 'CRC');
  ok('L: colones in English', P.money(1250000) === '₡1,250,000', P.money(1250000));
  P.setLocale('es', 'USD');
  ok('L: dollars in Costa Rican Spanish keep their cents: $1 200,00', P.money(1200).replace(/\s/g, ' ') === '$1 200,00', P.money(1200));
  P.setLocale('en', 'USD');
  ok('L: dollars in English: $1,200.00', P.money(1200) === '$1,200.00');
  P.setLocale('es', 'CRC');
  ok('L: colones typed the Costa Rican way: 25.000 / 25 000,50 / ₡18.500 / ¢18500', P.parseAmount('25.000').value === 25000 && P.parseAmount('25 000,50').value === 25000.5 && P.parseAmount('₡18.500').value === 18500 && P.parseAmount('¢18500').value === 18500 && P.parseAmount('1.234.567').value === 1234567, JSON.stringify(['25.000', '25 000,50', '₡18.500', '¢18500'].map(x => P.parseAmount(x).value)));
  P.setLocale('en', 'CRC');
  ok('L: an English phone with a colones list also reads 25.000 as twenty-five thousand', P.parseAmount('25.000').value === 25000 && P.parseAmount('25,000').value === 25000);
  P.setLocale('en', 'USD');
  ok('L: dollars in English still refuse 25.000 (three decimals), unchanged', !!P.parseAmount('25.000').error && P.parseAmount('94.50').value === 94.5);
  ok('L: errors show an example in the right currency', /like 94\.50/.test(P.parseAmount('abc').error) && (P.setLocale('en', 'CRC'), /like 25000/.test(P.parseAmount('abc').error)));
  P.setLocale('en', 'USD');
  const em = [{ date: '2026-11-04', subject: 'x' }];
  const ve = a => P.validateExtracted([{ email: 1, kind: 'bill', name: 'Big Co', amount: a, currency: 'CRC', date: '2026-11-20', repeat: 'monthly' }], em);
  ok('L: scan amounts up to hundreds of millions are accepted (colones are big numbers); absurd ones are dropped', ve(250000000)[0].amount === 250000000 && ve(2e9)[0].amount === null);
  ok('L: scan currency is kept only if USD or CRC', ve(5)[0].cur === 'CRC' && P.validateExtracted([{ email: 1, kind: 'bill', name: 'A Co', amount: 5, currency: 'EUR', date: '2026-11-20', repeat: 'none' }], em)[0].cur === null);
  const mf = (cur, listCur) => P.mergeFound([{ name: 'Netflix', amount: 15.99, cur, due: '2026-11-20', repeat: 'monthly', kind: 'bill', sent: '2026-11-04', subject: '' }], [], '2026-11-04', listCur)[0];
  ok('L: an amount in the other currency is held back, not copied in', mf('USD', 'CRC').amount === null && mf('USD', 'CRC').foreign.cur === 'USD' && mf('USD', 'CRC').foreign.amount === 15.99 && mf('USD', 'USD').amount === 15.99 && mf('USD', 'USD').foreign === null && mf(null, 'CRC').amount === 15.99 && mf('USD').amount === 15.99);

  // ---------- M. a mother in Costa Rica: Costa Rican Spanish, colones, icons
  const dayL = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const flat = el => el.textContent.replace(/\s+/g, ' ');
  const bL = makeBackend();
  p = open({ backend: bL, langs: ['es-CR', 'es'] });
  await until(() => !p.$('auth').hidden);
  await p.signIn('mama@example.test');
  ok('M: first time: Settings asks her name and currency; a phone set to Costa Rica pre-selects colones', await until(() => !p.$('name-scrim').hidden) && p.$('f-ucur').value === 'CRC' && /Ajustes/.test(p.$('name-title').textContent) && /Moneda/.test(p.doc.querySelector('label[for="f-ucur"]').textContent) && /Colones/.test(p.$('f-ucur').textContent) && /Dólares/.test(p.$('f-ucur').textContent), p.$('f-ucur').value);
  p.$('f-uname').value = 'Mamá'; p.submit('name-form');
  ok('M: the page says “Facturas de Mamá”', await until(() => p.$('title-text').textContent === 'Facturas de Mamá'), p.$('title-text').textContent);
  const profL = () => (bL.rows.find(r => r.id === 'profile') || {}).data;
  ok('M: name and currency are saved in her own profile', await until(() => !!profL() && profL().currency === 'CRC') && profL().currency === 'CRC' && profL().asked === true && profL().name === 'Mamá', JSON.stringify(profL()));
  ok('M: header button shows ₡ and names the currency', p.$('cur-btn').textContent === '₡' && /colones/.test(p.$('cur-btn').getAttribute('aria-label')) && !p.$('cur-btn').hidden);
  ok('M: the Add button says “Agregar una factura”', /Agregar una factura/.test(p.$('add-btn').textContent) && p.doc.title === 'Facturas');
  p.$('add-btn').click();
  ok('M: new-bill form shows ₡ and a colones placeholder', p.$('f-sym').textContent === '₡' && p.$('f-amount').getAttribute('placeholder') === '0' && /Nueva factura/.test(p.$('bill-title').textContent));
  p.$('f-name').value = 'Luz ICE'; p.$('f-amount').value = '24.750'; p.$('f-due').value = dayL(5); p.$('f-repeat').value = 'monthly'; p.submit('bill-form');
  ok('M: “24.750” is saved as twenty-four thousand seven hundred fifty', await until(() => bL.rows.some(r => r.data && r.data.name === 'Luz ICE' && r.data.amount === 24750)), JSON.stringify(bL.rows.map(r => r.data && r.data.amount)));
  ok('M: the list shows ₡24 750 and the tile adds it up', /₡24 750/.test(flat(p.$('content'))) && (flat(p.$('content')).match(/₡24 750/g) || []).length >= 3, flat(p.$('content')).slice(0, 200));
  p.fillBill('Kölbi', '18500,50', dayL(12));
  ok('M: cents show only when there are some: ₡18 500,50', await until(() => /₡18 500,50/.test(flat(p.$('content')))), flat(p.$('content')).slice(0, 300));
  const rowFor = n => [...p.$('content').querySelectorAll('.row')].find(r => r.textContent.includes(n));
  ok('M: each bill has a picture: electricity bolt and phone', rowFor('Luz ICE').querySelector('.bico').getAttribute('data-kind') === 'power' && rowFor('Kölbi').querySelector('.bico').getAttribute('data-kind') === 'phone' && !!rowFor('Luz ICE').querySelector('.bico svg') && rowFor('Luz ICE').querySelector('.bico').getAttribute('aria-hidden') === 'true');
  rowFor('Luz ICE').querySelector('[data-act="edit"]').click();
  ok('M: editing shows ₡ and the amount the way she types it (24750)', p.$('f-sym').textContent === '₡' && p.$('f-amount').value === '24750' && /Editar factura/.test(p.$('bill-title').textContent), p.$('f-amount').value);
  p.$('bill-cancel').click();
  rowFor('Kölbi').querySelector('[data-act="edit"]').click();
  ok('M: …and 18500,50 with a decimal comma', p.$('f-amount').value === '18500,50', p.$('f-amount').value);
  p.$('bill-cancel').click();
  p.$('add-btn').click(); p.$('f-name').value = 'Agua'; p.$('f-amount').value = 'abc'; p.submit('bill-form');
  ok('M: a bad amount is explained with a colones example', await until(() => !p.$('f-error').hidden) && /por ejemplo 25000/.test(p.$('f-error').textContent), p.$('f-error').textContent);
  p.$('bill-cancel').click();
  // switch to dollars from the header button
  p.$('cur-btn').click();
  ok('M: the ₡ button opens Settings with the currency box ready', !p.$('name-scrim').hidden && p.doc.activeElement === p.$('f-ucur') && p.$('f-ucur').value === 'CRC');
  p.$('f-ucur').value = 'USD'; p.submit('name-form');
  ok('M: dollars: the same numbers show with $ (nothing converted)', await until(() => /\$24 750,00/.test(flat(p.$('content')))) && p.$('cur-btn').textContent === '$' && bL.rows.some(r => r.data && r.data.name === 'Luz ICE' && r.data.amount === 24750) && await until(() => profL().currency === 'USD') && profL().name === 'Mamá', flat(p.$('content')).slice(0, 160));
  p.$('cur-btn').click(); p.$('f-ucur').value = 'CRC'; p.submit('name-form');
  await until(() => /₡24 750/.test(flat(p.$('content'))));
  // English with colones
  p.doc.querySelector('.date-row .lang-btn').click();
  ok('M: English page, colones list: ₡24,750', /₡24,750/.test(flat(p.$('content'))) && p.$('title-text').textContent === 'Mamá’s Bills', flat(p.$('content')).slice(0, 120));
  p.fillBill('Water', '25.000', dayL(9));
  ok('M: English page: “25.000” in a colones list is 25000', await until(() => bL.rows.some(r => r.data && r.data.name === 'Water' && r.data.amount === 25000)), JSON.stringify(bL.rows.map(r => r.data && r.data.amount)));
  ok('M: the water bill gets the water picture', rowFor('Water').querySelector('.bico').getAttribute('data-kind') === 'water');
  p.doc.querySelector('.date-row .lang-btn').click();
  ok('M: footer has a Settings link that opens the same sheet', /Ajustes/.test(flat(p.$('content'))) && (p.$('content').querySelector('[data-act="settings"]').click(), !p.$('name-scrim').hidden));
  p.$('name-cancel').click();
  ok('M: nothing else in the list screen is in English', !/\b(Due|Monthly|Overdue|Later|Paid|Sign out)\b/.test(flat(p.$('content'))), flat(p.$('content')).slice(-200));
  p.close();

  // legacy profile (no currency saved) stays in dollars; an English phone is offered dollars; closing the sheet keeps the choice
  const bOld = makeBackend(); const oldId = bOld.userId('old@example.test');
  bOld.session = { user: { id: oldId, email: 'old@example.test' } };
  bOld.rows.push({ user_id: oldId, id: 'profile', data: { name: 'Old', asked: true } }, { user_id: oldId, id: 'b1', data: { name: 'Phone', amount: 65, due: dayL(3), repeat: 'monthly', anchorDay: 1, paid: false, lastPaid: null } });
  p = open({ backend: bOld, langs: ['es-CR'] });
  ok('M: an existing list with no currency saved stays in dollars (even on a Costa Rican phone)', await until(() => /Phone/.test(p.$('content').textContent)) && /\$65,00/.test(flat(p.$('content'))) && p.$('cur-btn').textContent === '$');
  p.close();
  const bUS = makeBackend();
  p = open({ backend: bUS });
  await until(() => !p.$('auth').hidden); await p.signIn('sam@example.test');
  ok('M: an English phone is offered dollars', await until(() => !p.$('name-scrim').hidden) && p.$('f-ucur').value === 'USD');
  p.$('name-cancel').click();
  ok('M: closing the sheet without saving still remembers the first choice', await until(() => bUS.rows.some(r => r.id === 'profile' && r.data.currency === 'USD' && r.data.asked === true)), JSON.stringify(bUS.rows.map(r => r.data)));
  p.close();

  // this-phone-only mode keeps the currency on the phone, and examples come in colones
  p = open({ backend: makeBackend(), configured: false, langs: ['es-CR'] });
  await until(() => !p.$('name-scrim').hidden);
  p.$('f-uname').value = 'Tica'; p.$('f-ucur').value = 'CRC'; p.submit('name-form');
  await until(() => p.$('title-text').textContent === 'Facturas de Tica');
  ok('M: this-phone-only mode: currency saved on the phone', JSON.parse(p.lsAll()['mybills.profile.v1']).currency === 'CRC');
  p.$('content').querySelector('[data-act="examples"]').click();
  ok('M: example bills come in colones, with water, internet and rent pictures', await until(() => /₡280 000/.test(flat(p.$('content')))) && ['water', 'internet', 'home', 'phone', 'power'].every(k => !!p.$('content').querySelector('.bico[data-kind="' + k + '"]')), flat(p.$('content')).slice(0, 200));
  p.close();

  // ---------- N. staying signed in
  const dayN = dayL;
  const savedLogin = JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_at: 1, user: { id: 'u' } });
  const mom = () => {
    const b = makeBackend(); const id = b.userId('mom@example.test');
    b.session = { user: { id, email: 'mom@example.test' } };
    b.rows.push({ user_id: id, id: 'profile', data: { name: 'Mamá', asked: true, currency: 'CRC' } }, { user_id: id, id: 'b1', data: { name: 'Luz', amount: 24750, due: dayN(5), repeat: 'monthly', anchorDay: 1, paid: false, lastPaid: null } });
    return b;
  };
  // a phone that has just woken up has no connection yet: the login check fails twice, then works
  let bN = mom(); bN.sessionFails = 2;
  p = open({ backend: bN, ls: { 'sb-x-auth-token': savedLogin, 'mybills.lang': 'es' } });
  await sleep(250);
  ok('N: a login check that fails while a login is saved does NOT show the sign-in screen', p.$('auth').hidden && !p.doc.querySelector('.app').hidden && !!p.$('content').querySelector('.skel'));
  p.w.dispatchEvent(new p.w.Event('online')); await sleep(120);
  ok('N: …and keeps waiting after a second failure', p.$('auth').hidden && !!p.$('content').querySelector('.skel') && bN.sessionFails === 0);
  p.w.dispatchEvent(new p.w.Event('online'));
  ok('N: …then signs in by itself when the connection is back (list and colones intact)', await until(() => /Luz/.test(p.$('content').textContent)) && p.$('auth').hidden && /₡24 750/.test(flat(p.$('content'))) && p.$('title-text').textContent === 'Facturas de Mamá');
  p.close();
  // no events at all: it retries on its own timer
  bN = mom(); bN.sessionFails = 1;
  p = open({ backend: bN, ls: { 'sb-x-auth-token': savedLogin } });
  ok('N: it also retries on its own after a moment', await until(() => /Luz/.test(p.$('content').textContent), 6000) && p.$('auth').hidden);
  p.close();
  // the login arrives through the library's own event instead
  bN = mom(); bN.sessionFails = 999; const momSession = bN.session;
  p = open({ backend: bN, ls: { 'sb-x-auth-token': savedLogin } });
  await sleep(200); bN.session = momSession; bN.sessionFails = 0;
  bN.listeners.forEach(cb => cb('TOKEN_REFRESHED', momSession));
  ok('N: …or when the library announces a refreshed login', await until(() => /Luz/.test(p.$('content').textContent)) && p.$('auth').hidden);
  p.close();
  // the server itself says the login is no good (400): then, and only then, sign in again
  bN = mom(); bN.session = null; bN.sessionFails = 1; bN.sessionError = { name: 'AuthApiError', status: 400, message: 'Invalid Refresh Token: Refresh Token Not Found' };
  p = open({ backend: bN, ls: { 'sb-x-auth-token': savedLogin } });
  ok('N: a login the server refuses sends her to sign in, and clears it', await until(() => !p.$('auth').hidden) && bN.log.some(l => l[0] === 'signOut' && /local/.test(l[1])));
  p.close();
  // a saved login that is gone and nothing in storage: sign in at once
  p = open({ backend: makeBackend() });
  ok('N: no saved login => sign-in screen right away', await until(() => !p.$('auth').hidden));
  p.close();
  // signed out elsewhere while the page is open
  bN = mom(); p = open({ backend: bN, ls: { 'sb-x-auth-token': savedLogin } });
  await until(() => /Luz/.test(p.$('content').textContent));
  bN.session = null; bN.listeners.forEach(cb => cb('SIGNED_OUT', null));
  ok('N: signed out for real while the page is open => sign-in screen', await until(() => !p.$('auth').hidden));
  p.close();
  // while recovering, a lapsed login must not wipe the list with an empty answer
  bN = mom();
  p = open({ backend: bN, ls: { 'sb-x-auth-token': savedLogin } });
  await until(() => /Luz/.test(p.$('content').textContent));
  const realNowN = p.w.Date.now; p.w.Date.now = () => realNowN.call(p.w.Date) + 60000;
  bN.session = null; bN.anonFallback = true; bN.sessionFails = 3;
  p.w.dispatchEvent(new p.w.Event('online')); await sleep(150);
  ok('N: a refresh that comes back empty because the login lapsed does not erase what is on screen', /Luz/.test(p.$('content').textContent) && !/Aún no hay|No bills yet/.test(p.$('content').textContent));
  p.close();

  // the code step survives the page being closed while she reads her mail
  const bP = makeBackend();
  p = open({ backend: bP, langs: ['es-CR'] });
  await until(() => !p.$('auth').hidden);
  p.$('a-email').value = 'Mama@Example.test'; p.submit('auth-email-form');
  await until(() => !p.$('auth-code-form').hidden);
  let lsP = p.lsAll(); p.close();
  ok('N: the email waiting for a code is remembered on the device', JSON.parse(lsP['mybills.pendingCode']).email === 'mama@example.test' && lsP['mybills.lastEmail'] === 'mama@example.test');
  p = open({ backend: bP, ls: lsP, langs: ['es-CR'] });
  await until(() => !p.$('auth').hidden);
  ok('N: coming back lands on the code box for the same email (not on a blank form)', !p.$('auth-code-form').hidden && p.$('auth-email-form').hidden && /mama@example\.test/.test(p.$('a-sent').textContent) && /Enviamos un código/.test(p.$('a-sent').textContent) && !p.$('a-resend').disabled && /Enviar un código nuevo$/.test(p.$('a-resend').textContent), p.$('a-resend').textContent);
  p.$('a-code').value = '123456'; p.submit('auth-code-form');
  ok('N: the code still works, and the waiting state is cleared', await until(() => p.$('auth').hidden) && !p.lsAll()['mybills.pendingCode'] && p.lsAll()['mybills.lastEmail'] === 'mama@example.test');
  p.close();
  // too old: back to the email box, with her email filled in
  const oldPending = { ...lsP, 'mybills.pendingCode': JSON.stringify({ email: 'mama@example.test', at: Date.now() - 56 * 60 * 1000 }) };
  p = open({ backend: makeBackend(), ls: oldPending });
  await until(() => !p.$('auth').hidden);
  ok('N: an hour-old code request is not restored; her email is filled in', !p.$('auth-email-form').hidden && p.$('auth-code-form').hidden && p.$('a-email').value === 'mama@example.test');
  p.$('a-email').value = 'mama@example.test'; p.submit('auth-email-form');
  await until(() => !p.$('auth-code-form').hidden);
  p.$('a-change').click();
  ok('N: “Use a different email” forgets the waiting code', !p.$('auth-email-form').hidden && !p.lsAll()['mybills.pendingCode']);
  p.close();
  // sign out forgets the code request but keeps the email for next time
  const bS = makeBackend();
  p = open({ backend: bS }); await until(() => !p.$('auth').hidden); await p.signIn('lee@example.test');
  p.$('name-cancel').click();
  await until(() => p.$('content').querySelector('[data-act="signout"]'));
  p.$('content').querySelector('[data-act="signout"]').click();
  ok('N: after signing out, the email box is filled in and there is no waiting code', await until(() => !p.$('auth').hidden) && p.$('a-email').value === 'lee@example.test' && !p.lsAll()['mybills.pendingCode'] && p.$('auth-code-form').hidden);
  p.close();

  // ---------- O. “stay signed in” hint for iPhone (Safari forgets sites it has not seen in a week; a Home Screen icon is exempt)
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  const bH = mom();
  p = open({ backend: bH, ua: IPHONE, ls: { 'sb-x-auth-token': savedLogin, 'mybills.lang': 'es' } });
  ok('O: iPhone in Safari: a one-time note explains how to stay signed in (Spanish)', await until(() => /Agregar a pantalla de inicio/.test(p.$('content').textContent)) && /Safari/.test(p.$('content').textContent) && !!p.$('content').querySelector('[data-act="hint-ok"]'));
  p.$('content').querySelector('[data-act="hint-ok"]').click();
  ok('O: “Entendido” hides it and remembers', !/Agregar a pantalla de inicio/.test(p.$('content').textContent) && p.lsAll()['mybills.homeHint'] === '1');
  p.close();
  p = open({ backend: mom(), ua: IPHONE, ls: { 'sb-x-auth-token': savedLogin, 'mybills.homeHint': '1' } });
  await until(() => /Luz/.test(p.$('content').textContent));
  ok('O: once dismissed it stays away', !p.$('content').querySelector('[data-act="hint-ok"]'));
  p.close();
  p = open({ backend: mom(), ua: IPHONE, standalone: true, ls: { 'sb-x-auth-token': savedLogin } });
  await until(() => /Luz/.test(p.$('content').textContent));
  ok('O: already added to the Home Screen => no note', !p.$('content').querySelector('[data-act="hint-ok"]'));
  p.close();
  p = open({ backend: mom(), ls: { 'sb-x-auth-token': savedLogin } });
  await until(() => /Luz/.test(p.$('content').textContent));
  ok('O: computer or Android => no note', !p.$('content').querySelector('[data-act="hint-ok"]'));
  p.close();

  // ---------- P. Add from Email with a colones list: amounts in the other currency are held back
  const bQ = makeBackend();
  p = open({ backend: bQ, langs: ['es-CR'] });
  await until(() => !p.$('auth').hidden); await p.signIn('ana@example.test');
  await until(() => !p.$('name-scrim').hidden);
  p.$('f-uname').value = 'Ana'; p.$('f-ucur').value = 'CRC'; p.submit('name-form');
  await until(() => p.$('title-text').textContent === 'Facturas de Ana');
  p.$('scan-btn').click();
  p.$('scan-text').value = 'Recibo de la luz de ICE por ₡24.750 vence pronto. Netflix cobró $15,99 este mes.'; p.$('scan-text').dispatchEvent(new p.w.Event('input', { bubbles: true }));
  bQ.fnReply = { data: { bills: [
    { kind: 'bill', name: 'ICE Luz', amount: 24750, currency: 'CRC', date: dayL(6), repeat: 'monthly' },
    { kind: 'bill', name: 'Netflix', amount: 15.99, currency: 'USD', date: dayL(9), repeat: 'monthly' },
    { kind: 'bill', name: 'Kölbi', amount: 18500, currency: null, date: dayL(11), repeat: 'monthly' },
  ] }, error: null };
  p.$('scan-go').click();
  await until(() => !p.$('scan-results').hidden);
  const resQ = flat(p.$('scan-results'));
  ok('P: the function is told the list is in colones', bQ.fnCalls[0].body.currency === 'CRC' && bQ.fnCalls[0].body.lang === 'es');
  ok('P: colones amounts appear as ₡; the dollar one is blank with a plain explanation (Spanish)', /₡24 750/.test(resQ) && /₡18 500/.test(resQ) && /Se cobra en dólares \(\$15,99\)\. Su lista es en colones, así que el monto queda en blanco\./.test(resQ), resQ.slice(0, 400));
  const liQ = n => [...p.$('scan-list').children].find(li => li.textContent.includes(n));
  ok('P: results show pictures (bolt, TV, phone)', liQ('ICE').querySelector('.bico').getAttribute('data-kind') === 'power' && liQ('Netflix').querySelector('.bico').getAttribute('data-kind') === 'tv' && liQ('Kölbi').querySelector('.bico').getAttribute('data-kind') === 'phone' && liQ('Netflix').querySelector('.scan-note.warn'));
  p.$('scan-add').click();
  ok('P: adding keeps the dollar bill with no amount, and the colones ones as typed', await until(() => bQ.rows.some(r => r.data && r.data.name === 'Netflix')) && bQ.rows.find(r => r.data && r.data.name === 'Netflix').data.amount === null && bQ.rows.find(r => r.data && r.data.name === 'ICE Luz').data.amount === 24750);
  p.close();
  // dollars list, a bill in colones
  const bR = makeBackend();
  p = open({ backend: bR });
  await until(() => !p.$('auth').hidden); await p.signIn('pat@example.test');
  p.$('f-uname').value = 'Pat'; p.submit('name-form');
  await until(() => p.$('title-text').textContent === 'Pat’s Bills');
  p.$('scan-btn').click();
  p.$('scan-text').value = 'Your ICE bill is 24,750 colones, due soon. Thanks for being a customer.'; p.$('scan-text').dispatchEvent(new p.w.Event('input', { bubbles: true }));
  bR.fnReply = { data: { bills: [{ kind: 'bill', name: 'ICE Luz', amount: 24750, currency: 'CRC', date: dayL(6), repeat: 'monthly' }, { kind: 'bill', name: 'Acme Power', amount: 94.5, currency: 'USD', date: dayL(7), repeat: 'monthly' }] }, error: null };
  p.$('scan-go').click(); await until(() => !p.$('scan-results').hidden);
  const resR = flat(p.$('scan-results'));
  ok('P: dollars list: the function is told USD; a colones bill is explained in English; the dollar bill keeps $94.50', bR.fnCalls[0].body.currency === 'USD' && /Billed in colones \(₡24,750\)\. Your list is in dollars, so the amount is left blank\./.test(resR) && /\$94\.50/.test(resR), resR.slice(0, 400));
  p.close();
  // an older function that does not know about currencies: nothing changes
  const bT = makeBackend();
  p = open({ backend: bT, langs: ['es-CR'] });
  await until(() => !p.$('auth').hidden); await p.signIn('old2@example.test');
  await until(() => !p.$('name-scrim').hidden); p.$('f-ucur').value = 'CRC'; p.submit('name-form');
  await until(() => !p.$('name-scrim').hidden === false);
  p.$('scan-btn').click();
  p.$('scan-text').value = 'Recibo del agua de AyA por 9.800 colones, vence pronto, gracias.'; p.$('scan-text').dispatchEvent(new p.w.Event('input', { bubbles: true }));
  bT.fnReply = { data: { bills: [{ kind: 'bill', name: 'AyA Agua', amount: 9800, date: dayL(6), repeat: 'monthly' }] }, error: null };
  p.$('scan-go').click(); await until(() => !p.$('scan-results').hidden);
  ok('P: a reply without a currency is taken as the list’s own currency', /₡9 800/.test(flat(p.$('scan-results'))) && !p.$('scan-results').querySelector('.scan-note.warn') && p.$('scan-list').querySelector('.bico').getAttribute('data-kind') === 'water');
  p.close();

  process.exit(failed ? 1 : 0);
})();
