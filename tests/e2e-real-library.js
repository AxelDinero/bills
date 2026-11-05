// End-to-end in a real browser with the REAL supabase-js library (the exact file the site loads from the CDN),
// talking to a fake Supabase server. Checks the headers, the sign-in calls and the saves that really go over the wire.
// Usage: node e2e-real-library.js <site folder> <path to supabase-js dist/umd/supabase.js>   (needs playwright)
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const site = path.resolve(process.argv[2]), umd = fs.readFileSync(process.argv[3], 'utf8');
const URL_ = 'https://bvuoeamkgkelapzotpqy.supabase.co';
let failed = false;
const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (x !== undefined ? ' -> ' + x : '')); if (!c) failed = true; };

const types = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, r) => {
  const f = path.join(site, q.url.split('?')[0] === '/' ? 'index.html' : q.url.split('?')[0]);
  if (!f.startsWith(site) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(fs.readFileSync(f));
});

(async () => {
  await new Promise(r => srv.listen(0, r));
  const base = 'http://localhost:' + srv.address().port + '/';
  const rows = [], reqs = [];
  const state = { refresh: 'ok' };   // what the refresh endpoint does: 'ok' | 'offline' (no connection) | 'refused' (server says the login is no good)
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.route('https://cdn.jsdelivr.net/**', r => r.fulfill({ contentType: 'text/javascript', body: umd }));
  await ctx.route(URL_ + '/**', async route => {
    const q = route.request(), u = new globalThis.URL(q.url()), h = q.headers(), m = q.method();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    reqs.push({ m, p: u.pathname + u.search, apikey: h['apikey'], auth: h['authorization'], body: q.postData() });
    const json = (o, s = 200) => route.fulfill({ status: s, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(o) });
    if (u.pathname === '/auth/v1/otp') return json({});
    if (u.pathname === '/auth/v1/verify') {
      const body = JSON.parse(q.postData());
      if (body.token !== '123456') return json({ code: 403, error_code: 'otp_expired', msg: 'Token has expired or is invalid' }, 403);
      const payload = Buffer.from(JSON.stringify({ sub: 'u1', exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' })).toString('base64url');
      return json({ access_token: 'e30.' + payload + '.sig', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r1',
        user: { id: 'u1', aud: 'authenticated', role: 'authenticated', email: 'maria@example.test' } });
    }
    if (u.pathname === '/auth/v1/token') {
      if (state.refresh === 'offline') return route.abort('connectionfailed');
      if (state.refresh === 'refused') return json({ code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' }, 400);
      const payload = Buffer.from(JSON.stringify({ sub: 'u1', exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' })).toString('base64url');
      return json({ access_token: 'e30.' + payload + '.sig2', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r2',
        user: { id: 'u1', aud: 'authenticated', role: 'authenticated', email: 'maria@example.test' } });
    }
    if (u.pathname === '/auth/v1/logout') return route.fulfill({ status: 204, headers: cors });
    if (u.pathname === '/functions/v1/scan-bill' && m === 'POST') { const d = new Date(); d.setDate(d.getDate() + 10); const due = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); return json({ bills: [{ kind: 'bill', name: 'Acme Power', amount: 94.5, date: due, repeat: 'monthly' }] }); }
    if (u.pathname === '/rest/v1/docs') {
      if (m === 'GET') return json(rows.map(r => ({ id: r.id, data: r.data })));
      if (m === 'POST') {
        const body = JSON.parse(q.postData());
        const i = rows.findIndex(r => r.id === body.id);
        if (i >= 0) rows[i] = body; else rows.push(body);
        return route.fulfill({ status: 201, headers: cors, body: '' });
      }
      if (m === 'DELETE') { const id = u.searchParams.get('id').replace('eq.', ''); const i = rows.findIndex(r => r.id === id); if (i >= 0) rows.splice(i, 1); return route.fulfill({ status: 204, headers: cors }); }
    }
    return json({}, 404);
  });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(base);
  await page.waitForSelector('#auth:not([hidden])');
  ok('real library loaded and sign-in screen shown', await page.evaluate(() => typeof window.supabase.createClient === 'function'));
  await page.fill('#a-email', 'Maria@Example.test');
  await page.click('#a-send');
  await page.waitForSelector('#auth-code-form:not([hidden])');
  const otp = reqs.find(r => r.p === '/auth/v1/otp');
  ok('code request sent with the publishable key', otp && otp.apikey.startsWith('sb_publishable_') && /"email":"maria@example.test"/.test(otp.body), otp && otp.body);
  await page.fill('#a-code', '000000'); await page.click('#a-verify');
  await page.waitForSelector('#a-code-error:not([hidden])');
  ok('wrong code => message, still signed out', /didn.t work/.test(await page.textContent('#a-code-error')) && !(await page.isHidden('#auth')));
  await page.fill('#a-code', '123456'); await page.click('#a-verify');
  await page.waitForSelector('#auth', { state: 'hidden' });
  await page.waitForSelector('#name-scrim:not([hidden])');
  await page.fill('#f-uname', 'Maria'); await page.click('#name-save');
  await page.waitForFunction(() => document.getElementById('title-text').textContent === 'Maria’s Bills');
  ok('signed in, name asked and shown', true);
  await page.click('#add-btn');
  await page.fill('#f-name', 'Rent'); await page.fill('#f-amount', '1200'); await page.fill('#f-due', '2026-12-01'); await page.selectOption('#f-repeat', 'monthly');
  await page.click('#bill-save');
  await page.waitForSelector('.row');
  await page.waitForFunction(() => document.getElementById('content').textContent.includes('Rent'));
  await page.waitForTimeout(300);
  ok('bill saved to the server', rows.some(r => r.data && r.data.name === 'Rent' && r.data.amount === 1200 && r.user_id === 'u1'), JSON.stringify(rows.map(r => r.id)));
  const up = reqs.filter(r => r.m === 'POST' && r.p.startsWith('/rest/v1/docs')).pop();
  ok('save is an upsert on (user_id,id) using the signed-in session', /on_conflict=user_id%2Cid/.test(up.p) && /^Bearer e30\./.test(up.auth) && up.apikey.startsWith('sb_publishable_'), up.p + ' | ' + (up.auth || '').slice(0, 14));
  ok('the session token, not the publishable key, is used for data', reqs.filter(r => r.p.startsWith('/rest/v1/')).every(r => /^Bearer e30\./.test(r.auth)));

  // Add from Email, through the real library: who is calling, with which headers, and what gets saved
  await page.click('#scan-btn');
  await page.fill('#scan-text', 'Your Acme Power bill of $94.50 is ready. Pay by the due date to avoid a late fee.');
  await page.click('#scan-go');
  await page.waitForSelector('#scan-results:not([hidden])');
  const fn = reqs.find(r => r.p === '/functions/v1/scan-bill' && r.m === 'POST');
  ok('scan call goes to the scan-bill function with the signed-in session token and the publishable key', !!fn && /^Bearer e30\./.test(fn.auth) && fn.apikey.startsWith('sb_publishable_'), fn && (fn.auth || '').slice(0, 14));
  const fb = fn && JSON.parse(fn.body);
  ok('scan request carries the text, today’s date, the language and the list’s currency, and nothing else', !!fb && /Acme Power bill/.test(fb.text) && /^\d{4}-\d{2}-\d{2}$/.test(fb.today) && fb.lang === 'en' && fb.currency === 'USD' && Array.isArray(fb.images) && Object.keys(fb).sort().join() === 'currency,images,lang,text,today', fn && Object.keys(fb).join());
  await page.click('#scan-add');
  await page.waitForFunction(() => document.getElementById('content').textContent.includes('Acme Power'));
  await page.waitForTimeout(300);
  ok('the bill found by the scan is saved to her account', rows.some(r => r.data && r.data.name === 'Acme Power' && r.data.amount === 94.5 && r.user_id === 'u1'), JSON.stringify(rows.map(r => r.id)));

  await page.reload();
  await page.waitForFunction(() => document.getElementById('content').textContent.includes('Rent'));
  ok('reload keeps the login and shows the bill', await page.isHidden('#auth') && (await page.textContent('#title-text')) === 'Maria’s Bills');
  await page.click('[data-act="signout"]');
  await page.waitForSelector('#auth:not([hidden])');
  ok('sign out returns to the sign-in screen and stays signed out after reload', await (async () => { await page.reload(); await page.waitForSelector('#auth:not([hidden])'); return true; })());
  const lo = reqs.find(r => r.p.startsWith('/auth/v1/logout'));
  ok('sign out only for this device (scope=local)', lo && /scope=local/.test(lo.p), lo && lo.p);

  // ---- staying signed in, with the real library
  // (1) she asked for a code, went to read her mail, and the phone closed the page
  await page.fill('#a-email', 'maria@example.test'); await page.click('#a-send');
  await page.waitForSelector('#auth-code-form:not([hidden])');
  await page.reload();
  await page.waitForSelector('#auth:not([hidden])');
  ok('closing the page while waiting for the code comes back to the code box, same email', (await page.isVisible('#auth-code-form')) && /maria@example\.test/.test(await page.textContent('#a-sent')));
  await page.fill('#a-code', '123456'); await page.click('#a-verify');
  await page.waitForSelector('#auth', { state: 'hidden' });
  await page.waitForFunction(() => document.getElementById('content').textContent.includes('Rent'));
  const KEY = 'sb-bvuoeamkgkelapzotpqy-auth-token';
  const expire = () => page.evaluate(k => { const o = JSON.parse(localStorage.getItem(k)); o.expires_at = Math.floor(Date.now() / 1000) - 60; localStorage.setItem(k, JSON.stringify(o)); return !!o.refresh_token; }, KEY);
  ok('the code works after coming back; the waiting state is cleared', await page.evaluate(() => !localStorage.getItem('mybills.pendingCode')) && await expire());
  // (2) a day later the saved access token has expired, and the phone has just woken up with no connection
  state.refresh = 'offline';
  await page.reload();
  await page.waitForTimeout(2200);
  ok('expired token + no connection: the sign-in screen is NOT shown and the saved login is kept', (await page.isHidden('#auth')) && !!(await page.$('.skel')) && await page.evaluate(k => !!localStorage.getItem(k), KEY));
  state.refresh = 'ok';
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => document.getElementById('content').textContent.includes('Rent'), null, { timeout: 15000 });
  const back = { hidden: await page.isHidden('#auth'), title: await page.textContent('#title-text'), tok: await page.evaluate(k => JSON.parse(localStorage.getItem(k)).refresh_token, KEY) };
  ok('connection back: she is in with her bills, no code asked, and a fresh login is stored', back.hidden && back.title === 'Maria’s Bills' && back.tok === 'r2', JSON.stringify(back));
  // (2b) the same, but with no connection for longer than the library keeps retrying by itself (about 30 seconds); after that the library itself pauses real attempts for a minute. Slow (about 2 minutes): run with LONG=1.
  if (process.env.LONG) {
    state.refresh = 'offline'; await expire();
    await page.reload();
    await page.waitForTimeout(40000);
    ok('LONG: still no connection after 40 seconds: still no sign-in screen, login kept, skeleton showing', (await page.isHidden('#auth')) && !!(await page.$('.skel')) && await page.evaluate(k => !!localStorage.getItem(k), KEY));
    state.refresh = 'ok';
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForFunction(() => document.getElementById('content').textContent.includes('Rent'), null, { timeout: 90000 });
    ok('LONG: connection back: in with her bills, no code asked, fresh login stored', (await page.isHidden('#auth')) && await page.evaluate(k => JSON.parse(localStorage.getItem(k)).refresh_token === 'r2', KEY));
  }
  // (3) only when the server itself refuses the saved login does she have to sign in again
  state.refresh = 'refused'; await expire();
  await page.reload();
  await page.waitForSelector('#auth:not([hidden])', { timeout: 15000 });
  ok('server refuses the saved login => sign-in screen, and the dead login is removed', await page.evaluate(k => !localStorage.getItem(k), KEY));
  ok('no page errors', errors.length === 0, errors.join(' | '));
  await b.close(); srv.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
