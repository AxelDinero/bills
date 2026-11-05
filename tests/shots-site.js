// Screenshots of the website (sign-in screens and the signed-in list) with a fake Supabase, so the real layout can be checked by eye.
// Usage: node shots-site.js <site folder> <output folder> [locale, e.g. es-CR] [USD|CRC] [width in pixels, default 390]   (needs playwright)
const { chromium } = require('playwright');
const path = require('path');
const site = path.resolve(process.argv[2]), out = path.resolve(process.argv[3]), locale = process.argv[4] || 'en-US', CUR = process.argv[5] === 'CRC' ? 'CRC' : 'USD', WIDTH = +process.argv[6] || 390;
const ES = /^es/i.test(locale);
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
    const ctx = await b.newContext({ viewport: { width: WIDTH, height: 844 }, colorScheme: scheme, deviceScaleFactor: 1, locale });
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
    const A = (usd, crc) => (CUR === 'CRC' ? crc : usd);
    const rows = [
      ['b1', { name: ES ? 'Teléfono' : 'Phone', amount: A(65, 18500), due: plus(-2), repeat: 'monthly', anchorDay: 1, paid: false, lastPaid: null, example: false }],
      ['b2', { name: ES ? 'Luz' : 'Electric', amount: A(94.5, 24750), due: plus(3), repeat: 'monthly', anchorDay: 1, paid: false, lastPaid: null, example: false }],
      ['b3', { name: ES ? 'Agua' : 'Water', amount: A(38, 9800), due: plus(5), repeat: 'monthly', anchorDay: 1, paid: false, lastPaid: null, example: false }],
      ['b4', { name: 'Internet', amount: A(60, 22900), due: plus(9), repeat: 'monthly', anchorDay: 1, paid: false, lastPaid: null, example: false }],
      ['b5', { name: ES ? 'Alquiler' : 'Rent', amount: A(1200, 280000), due: plus(12), repeat: 'monthly', anchorDay: 1, paid: false, lastPaid: null, example: false }],
      ['b6', { name: 'Netflix', amount: A(15.99, 5500), due: plus(16), repeat: 'monthly', anchorDay: 1, paid: false, lastPaid: null, example: false }],
      ['b7', { name: ES ? 'Tarjeta BAC' : 'Credit card', amount: A(180, 95000), due: plus(20), repeat: 'monthly', anchorDay: 1, paid: false, lastPaid: null, example: false }],
      ['b8', { name: ES ? 'Seguro del carro' : 'Car insurance', amount: A(120, 61000), due: plus(24), repeat: 'monthly', anchorDay: 1, paid: false, lastPaid: null, example: false }],
      ['b9', { name: ES ? 'Basura' : 'Trash', amount: A(22, 4200), due: plus(-6), repeat: 'monthly', anchorDay: 1, paid: true, lastPaid: plus(-6), example: false }],
      ['profile', { name: 'Maria', asked: true, currency: CUR }],
    ].map(([id, data]) => ({ id, data }));
    await page.evaluate(r => { localStorage.setItem('fakeSignedIn', '1'); localStorage.setItem('fakeRows', JSON.stringify(r)); }, rows);
    await page.reload();
    await page.waitForSelector('.row');
    await page.screenshot({ path: `${out}/site-list-${scheme}.png`, fullPage: false });
    await page.screenshot({ path: `${out}/site-list-full-${scheme}.png`, fullPage: true });
    // nothing may push the page wider than the phone, in either language
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    console.log((wide <= 0 ? 'PASS ' : 'FAIL ') + 'list fits the screen width (' + scheme + ', ' + locale + ') -> overflow ' + wide + 'px');
    await page.click('[data-act="edit"]');
    await page.waitForSelector('#bill-scrim:not([hidden])');
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${out}/site-edit-${scheme}.png`, fullPage: false });
    await page.click('#bill-cancel');
    await page.click('#cur-btn');
    await page.waitForSelector('#name-scrim:not([hidden])');
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${out}/site-settings-${scheme}.png`, fullPage: false });
    await ctx.close();
  }
  await b.close();
})();
