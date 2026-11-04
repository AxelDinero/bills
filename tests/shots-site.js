// Screenshots of the website (sign-in screens and the signed-in list) with a fake Supabase, so the real layout can be checked by eye.
// Usage: node shots-site.js <site folder> <output folder>   (needs playwright)
const { chromium } = require('playwright');
const path = require('path');
const site = path.resolve(process.argv[2]), out = path.resolve(process.argv[3]);
const pad = n => String(n).padStart(2, '0');
const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const plus = n => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };

const FAKE = `
window.supabase = { createClient: function () {
  var signedIn = localStorage.getItem('fakeSignedIn') === '1';
  var rows = JSON.parse(localStorage.getItem('fakeRows') || '[]');
  var q = function (v) { var api = { select: function () { return api; }, eq: function () { return api; }, upsert: function () { return api; }, delete: function () { return api; },
    then: function (res) { return Promise.resolve(v).then(res); } }; return api; };
  return {
    auth: {
      getSession: function () { return Promise.resolve({ data: { session: signedIn ? { user: { id: 'u1', email: 'maria@example.com' } } : null } }); },
      onAuthStateChange: function () { return { data: { subscription: {} } }; },
      signInWithOtp: function () { return Promise.resolve({ error: null }); },
      verifyOtp: function () { return Promise.resolve({ data: { session: null }, error: { message: 'x' } }); },
      signOut: function () { return Promise.resolve({}); }
    },
    from: function () { return q({ data: rows, error: null }); }
  };
} };`;

(async () => {
  const b = await chromium.launch();
  for (const scheme of ['light', 'dark']) {
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, colorScheme: scheme, deviceScaleFactor: 1 });
    await ctx.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: 'window.BILLS_CONFIG={SUPABASE_URL:"https://x.supabase.co",SUPABASE_KEY:"sb_publishable_x"};' }));
    await ctx.route('https://cdn.jsdelivr.net/**', r => r.fulfill({ contentType: 'text/javascript', body: FAKE }));
    const page = await ctx.newPage();
    await page.goto('file://' + site + '/index.html');
    await page.waitForSelector('#auth:not([hidden])');
    await page.screenshot({ path: `${out}/site-auth-${scheme}.png` });
    await page.fill('#a-email', 'maria@example.com');
    await page.click('#a-send');
    await page.waitForSelector('#auth-code-form:not([hidden])');
    await page.fill('#a-code', '12345');
    await page.screenshot({ path: `${out}/site-code-${scheme}.png` });
    await page.click('#a-verify');
    await page.waitForSelector('#a-code-error:not([hidden])');
    await page.screenshot({ path: `${out}/site-codeerr-${scheme}.png` });
    // signed-in list
    const rows = [
      ['b1', { name: 'Phone', amount: 65, due: plus(-2), repeat: 'monthly', anchorDay: 1, paid: false, lastPaid: null, example: false }],
      ['b2', { name: 'Electric', amount: 94.5, due: plus(3), repeat: 'monthly', anchorDay: 1, paid: false, lastPaid: null, example: false }],
      ['b3', { name: 'Rent', amount: 1200, due: plus(9), repeat: 'monthly', anchorDay: 1, paid: false, lastPaid: null, example: false }],
      ['profile', { name: 'Maria', asked: true }],
    ].map(([id, data]) => ({ id, data }));
    await page.evaluate(r => { localStorage.setItem('fakeSignedIn', '1'); localStorage.setItem('fakeRows', JSON.stringify(r)); }, rows);
    await page.reload();
    await page.waitForSelector('.row');
    await page.screenshot({ path: `${out}/site-list-${scheme}.png`, fullPage: false });
    await ctx.close();
  }
  await b.close();
})();
