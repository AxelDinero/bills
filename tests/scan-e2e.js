// "Add from Email" in a real browser (Chromium via Playwright): real picture shrinking, the camera and screenshot pickers, the layout on a phone.
// The Supabase library and the scan-bill function are stand-ins; made-up people and bills only.
// Usage: node scan-e2e.js <site folder> <output folder for screenshots> [locale, e.g. es-US]   (needs playwright)
const { chromium } = require('playwright');
const path = require('path');
const site = path.resolve(process.argv[2]), out = path.resolve(process.argv[3]), locale = process.argv[4] || 'en-US';
const ES = /^es/i.test(locale);
let failed = false;
const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (x !== undefined ? ' -> ' + x : '')); if (!c) failed = true; };
const pad = n => String(n).padStart(2, '0');
const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const plus = n => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };

const FAKE = `
window.__calls = [];
window.supabase = { createClient: function () {
  var rows = JSON.parse(localStorage.getItem('fakeRows') || '[]');
  var q = function (v) { var api = { select: function () { return api; }, eq: function () { return api; }, upsert: function () { return api; }, delete: function () { return api; },
    then: function (res) { return Promise.resolve(v).then(res); } }; return api; };
  return {
    auth: {
      getSession: function () { return Promise.resolve({ data: { session: { user: { id: 'u1', email: 'maria@example.com' } } } }); },
      onAuthStateChange: function () { return { data: { subscription: {} } }; },
      signInWithOtp: function () { return Promise.resolve({ error: null }); },
      verifyOtp: function () { return Promise.resolve({ data: { session: null }, error: { message: 'x' } }); },
      signOut: function () { return Promise.resolve({}); }
    },
    functions: { invoke: function (name, opts) {
      window.__calls.push({ name: name, body: opts.body });
      return new Promise(function (r) { setTimeout(function () { r(window.__reply || { data: { bills: [] }, error: null }); }, 400); });
    } },
    from: function () { return q({ data: rows, error: null }); }
  };
} };`;

(async () => {
  const b = await chromium.launch();
  for (const scheme of ['light', 'dark']) {
    for (const width of [390, 320]) {
      const ctx = await b.newContext({ viewport: { width, height: 844 }, colorScheme: scheme, deviceScaleFactor: 1, locale });
      await ctx.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: 'window.BILLS_CONFIG={SUPABASE_URL:"https://x.supabase.co",SUPABASE_KEY:"sb_publishable_x"};' }));
      await ctx.route('https://cdn.jsdelivr.net/**', r => r.fulfill({ contentType: 'text/javascript', body: FAKE }));
      const page = await ctx.newPage();
      const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
      const tag = `${scheme}-${width}`;
      const rows = [
        ['b1', { name: ES ? 'Teléfono' : 'Phone', amount: 65, due: plus(-2), repeat: 'monthly', anchorDay: 1, paid: false, lastPaid: null, example: false }],
        ['b2', { name: ES ? 'Luz' : 'Electric', amount: 94.5, due: plus(3), repeat: 'monthly', anchorDay: 1, paid: false, lastPaid: null, example: false }],
        ['b3', { name: ES ? 'Alquiler' : 'Rent', amount: 1200, due: plus(9), repeat: 'monthly', anchorDay: 1, paid: false, lastPaid: null, example: false }],
        ['b4', { name: 'Streaming', amount: 15.99, due: plus(20), repeat: 'monthly', anchorDay: 1, paid: false, lastPaid: null, example: false }],
        ['b5', { name: 'Internet', amount: 60, due: plus(24), repeat: 'monthly', anchorDay: 1, paid: false, lastPaid: null, example: false }],
        ['profile', { name: 'Maria', asked: true }],
      ].map(([id, data]) => ({ id, data }));
      await page.goto('file://' + site + '/index.html');
      await page.evaluate(r => localStorage.setItem('fakeRows', JSON.stringify(r)), rows);
      await page.reload();
      await page.waitForSelector('.row');
      const wide = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

      // the bottom bar: two buttons, nothing covered, nothing sideways
      ok(`[${tag}] both buttons are showing`, await page.isVisible('#add-btn') && await page.isVisible('#scan-btn'));
      ok(`[${tag}] the page is not wider than the phone`, (await wide()) <= 0, await wide());
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(150);
      const geo = await page.evaluate(() => {
        const bar = document.querySelector('.bar').getBoundingClientRect(), rows = [...document.querySelectorAll('.row, .foot')], last = rows[rows.length - 1].getBoundingClientRect();
        const a = document.getElementById('add-btn').getBoundingClientRect(), s = document.getElementById('scan-btn').getBoundingClientRect();
        return { barTop: bar.top, lastBottom: last.bottom, aH: a.height, sH: s.height, sW: s.width, aW: a.width, vw: window.innerWidth, sOver: document.getElementById('scan-btn').scrollWidth - document.getElementById('scan-btn').clientWidth };
      });
      ok(`[${tag}] the last row can be scrolled clear of the bar`, geo.lastBottom <= geo.barTop + 1, JSON.stringify(geo));
      ok(`[${tag}] buttons are at least 48px tall and the label fits`, geo.aH >= 48 && geo.sH >= 48 && geo.sOver <= 0, JSON.stringify(geo));
      await page.evaluate(() => window.scrollTo(0, 0));
      if (width === 390) await page.screenshot({ path: `${out}/scan-bar-${tag}.png` });

      // open the sheet, add pictures
      await page.click('#scan-btn');
      await page.waitForSelector('#scan-scrim:not([hidden])');
      await page.waitForTimeout(350);
      ok(`[${tag}] Find Bills starts switched off`, await page.isDisabled('#scan-go'));
      if (width === 390) await page.screenshot({ path: `${out}/scan-sheet-${tag}.png` });

      const makePng = (w, h, label) => page.evaluate(([w, h, label]) => {
        const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d');
        g.clearRect(0, 0, w, h);                       // see-through background, like some screenshots
        g.fillStyle = '#0a3d62'; g.fillRect(w * 0.1, h * 0.1, w * 0.8, h * 0.18);
        g.fillStyle = '#000'; g.font = (h / 12) + 'px sans-serif'; g.fillText(label, w * 0.12, h * 0.5);
        return c.toDataURL('image/png').split(',')[1];
      }, [w, h, label]);
      const big = Buffer.from(await makePng(3000, 2000, 'ACME ELECTRIC  AMOUNT DUE $94.50'), 'base64');
      const small = Buffer.from(await makePng(600, 900, 'Phone bill $65.00'), 'base64');
      await page.setInputFiles('#scan-file', [{ name: 'shot1.png', mimeType: 'image/png', buffer: big }]);
      await page.waitForSelector('#scan-thumbs li');
      ok(`[${tag}] a thumbnail appears and Find Bills turns on (pictures alone are enough)`, (await page.locator('#scan-thumbs li').count()) === 1 && !(await page.isDisabled('#scan-go')));
      await page.setInputFiles('#scan-cam-file', [{ name: 'IMG_0001.jpg', mimeType: 'image/jpeg', buffer: small }]);   // what the camera input hands back
      await page.waitForFunction(() => document.querySelectorAll('#scan-thumbs li').length === 2);
      ok(`[${tag}] the camera picture is added too`, true);
      await page.setInputFiles('#scan-file', [{ name: 'a.png', mimeType: 'image/png', buffer: small }, { name: 'b.png', mimeType: 'image/png', buffer: small }]);
      await page.waitForFunction(() => document.querySelectorAll('#scan-thumbs li').length === 3);
      ok(`[${tag}] only 3 pictures fit, and the person is told`, (await page.locator('#scan-thumbs li').count()) === 3 && await page.isVisible('#scan-input-error'), await page.textContent('#scan-input-error'));
      if (width === 390) await page.screenshot({ path: `${out}/scan-thumbs-${tag}.png` });
      ok(`[${tag}] the sheet is not wider than the phone`, (await wide()) <= 0);
      await page.click('#scan-thumbs li:nth-child(3) button');
      ok(`[${tag}] a picture can be removed`, (await page.locator('#scan-thumbs li').count()) === 2 && !(await page.isVisible('#scan-input-error')));
      await page.setInputFiles('#scan-file', [{ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('this is not really a picture '.repeat(10)) }]);
      await page.waitForSelector('#scan-input-error:not([hidden])');
      ok(`[${tag}] a broken picture gives a plain message and is not added`, (await page.locator('#scan-thumbs li').count()) === 2 && /open that picture|abrir esa imagen/.test(await page.textContent('#scan-input-error')), await page.textContent('#scan-input-error'));
      await page.fill('#scan-text', ES ? 'Mi recibo de luz vence pronto, son $94.50.' : 'My electric bill is due soon, it is $94.50.');

      // send
      await page.evaluate(([d1, d2]) => { window.__reply = { data: { bills: [
        { kind: 'bill', name: 'Acme Power', amount: 94.5, date: d1, repeat: 'monthly' },
        { kind: 'bill', name: 'Bright Mobile', amount: 65, date: d2, repeat: 'monthly' },
        { kind: 'receipt', name: 'Water Dept', amount: 40, date: d1, repeat: 'monthly' }] }, error: null }; }, [plus(5), plus(12)]);
      await page.click('#scan-go');
      await page.waitForSelector('#scan-busy:not([hidden])');
      if (width === 390) await page.screenshot({ path: `${out}/scan-busy-${tag}.png` });
      await page.waitForSelector('#scan-results:not([hidden])');
      const call = await page.evaluate(() => window.__calls[window.__calls.length - 1]);
      ok(`[${tag}] one call to scan-bill with the text and two pictures`, call.name === 'scan-bill' && call.body.images.length === 2 && /electric bill|recibo de luz/.test(call.body.text) && call.body.lang === (ES ? 'es' : 'en'), JSON.stringify(Object.keys(call.body)));
      const dims = await page.evaluate(async bodies => Promise.all(bodies.map(im => new Promise(res => { const i = new Image(); i.onload = () => res({ w: i.naturalWidth, h: i.naturalHeight, type: im.media_type, len: im.data.length, head: im.data.slice(0, 4) }); i.onerror = () => res(null); i.src = 'data:' + im.media_type + ';base64,' + im.data; }))), call.body.images);
      ok(`[${tag}] pictures go as JPEG, shrunk to 1600 pixels on the long side, keeping the shape`, dims.every(d => d && d.type === 'image/jpeg' && d.head === '/9j/') && dims[0].w === 1600 && dims[0].h === 1067 && dims[1].w === 600 && dims[1].h === 900, JSON.stringify(dims));
      ok(`[${tag}] and are small enough to upload quickly`, dims.every(d => d.len < 400000), dims.map(d => d.len).join());
      const px = await page.evaluate(async im => new Promise(res => { const i = new Image(); i.onload = () => { const c = document.createElement('canvas'); c.width = i.naturalWidth; c.height = i.naturalHeight; const g = c.getContext('2d'); g.drawImage(i, 0, 0); const d = g.getImageData(2, 2, 1, 1).data; res([d[0], d[1], d[2]]); }; i.src = 'data:image/jpeg;base64,' + im; }), call.body.images[0].data);
      ok(`[${tag}] see-through areas became white, not black`, px.every(v => v > 235), JSON.stringify(px));
      ok(`[${tag}] results listed`, (await page.locator('#scan-list li').count()) === 3);
      ok(`[${tag}] the results screen is not wider than the phone`, (await wide()) <= 0);
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${out}/scan-results-${tag}.png` });
      // the Add button must be reachable
      const addBox = await page.evaluate(() => { const r = document.getElementById('scan-add').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, vh: window.innerHeight }; });
      ok(`[${tag}] the Add button is on screen`, addBox.bottom <= addBox.vh && addBox.top >= 0, JSON.stringify(addBox));
      await page.click('#scan-add');
      await page.waitForSelector('#scan-scrim', { state: 'hidden' });
      await page.waitForSelector('#toast:not([hidden])');
      const toastPos = await page.evaluate(() => { const t = document.getElementById('toast').getBoundingClientRect(), b = document.querySelector('.bar').getBoundingClientRect(); return { toastBottom: t.bottom, barTop: b.top }; });
      ok(`[${tag}] the toast sits above the two-button bar`, toastPos.toastBottom <= toastPos.barTop, JSON.stringify(toastPos));
      if (width === 390) await page.screenshot({ path: `${out}/scan-added-${tag}.png` });
      const listNow = (await page.textContent('#content')).replace(/\s+/g, ' ');
      ok(`[${tag}] the new bills are in the list`, /Acme Power/.test(listNow) && /Bright Mobile/.test(listNow) && /Water Dept/.test(listNow), listNow.slice(0, 300));

      // reopening: the old pictures and text are gone
      await page.waitForTimeout(100);
      await page.click('#scan-btn');
      await page.waitForSelector('#scan-scrim:not([hidden])');
      ok(`[${tag}] reopening shows no old pictures or text`, (await page.locator('#scan-thumbs li').count()) === 0 && (await page.inputValue('#scan-text')) === '' && await page.isDisabled('#scan-go'));
      ok(`[${tag}] no errors in the console`, errors.length === 0, errors.join(' | '));
      await ctx.close();
    }
  }
  await b.close();
  process.exit(failed ? 1 : 0);
})();
