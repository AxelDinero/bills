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
    rows: [], session: null, codes: {}, log: [], failWrites: false, sendError: null, listeners: [],
    userId: email => 'u_' + email.replace(/[^a-z]/g, ''),
    client() {
      const auth = {
        getSession: async () => ({ data: { session: b.session }, error: null }),
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
      return { auth, from };
    },
  };
  return b;
}

function open({ backend, configured = true, ls = {}, noLib = false }) {
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', url: 'https://example.com/', pretendToBeVisual: true,
    beforeParse(w) {
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

  process.exit(failed ? 1 : 0);
})();
