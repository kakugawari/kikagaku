/*
 * ブラウザで実際に動かして確かめるテスト。
 *
 *   npm i -D playwright && npm run test:ui
 *
 * 画面まわりの不具合は node のテストでは捕まらない。ここでは本物の
 * ブラウザを立ち上げ、指の操作をそのまま再現して確かめる。
 *
 * Anthropic API は本物を呼ばない。page.route で差し替え、見本の作図
 * (fixture.js) をストリームで細切れに返す。
 *
 * ★ 直した不具合には、かならず見張り役をここに置く。
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');
const FIX = require('./fixture.js');

const PORT = Number(process.env.PORT || 8123);
const URL = `http://localhost:${PORT}/`;
const ROOT = __dirname;
const CHROMIUM = process.env.CHROMIUM_PATH;   // 手元の Chromium を使いたいとき
const API = 'https://api.anthropic.com/v1/messages';

let passed = 0;
let failed = 0;

function ok(condition, message) {
  if (condition) {
    passed++;
    console.log('  \x1b[32m✓\x1b[0m ' + message);
  } else {
    failed++;
    console.log('  \x1b[31m✗ FAIL\x1b[0m ' + message);
  }
}

function skip(message) {
  console.log('  \x1b[90m- とばした: ' + message + '\x1b[0m');
}

function section(name) {
  console.log('\n' + name);
}

function waitForServer() {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      http.get(URL, (res) => { res.resume(); resolve(); })
        .on('error', () => {
          if (Date.now() - started > 10000) reject(new Error('サーバーが起動しない'));
          else setTimeout(tick, 100);
        });
    };
    tick();
  });
}

/** 対象は iPhone 16 Plus だけ。playwright がその名前を知らなければ、同じ大きさで代える */
function phoneDevice(devices) {
  return devices['iPhone 16 Plus'] || {
    viewport: { width: 430, height: 739 }, screen: { width: 430, height: 932 },
    deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
  };
}

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };

/** 見本の作図を、SSE のイベントにして細かく刻む (切れ目がイベントの途中に来るように) */
function sseBody(design, stop = 'end_turn') {
  const text = JSON.stringify(design);
  const evs = [{ type: 'message_start', message: { model: 'claude-opus-5-5' } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }];
  for (let i = 0; i < text.length; i += 37) evs.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(i, i + 37) } });
  evs.push({ type: 'message_delta', delta: { stop_reason: stop } }, { type: 'message_stop' });
  return evs.map((e) => `event: ${e.type}\r\ndata: ${JSON.stringify(e)}\r\n\r\n`).join('');
}

/**
 * API を差し替える。calls に届いた頼みを積む。
 * mode: 'ok' / 'bad_key' / 'slow' (返事をなかなか返さない)
 */
async function mockApi(page, calls, getMode) {
  await page.route(API, async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    calls.push({ headers: req.headers(), body: JSON.parse(req.postData() || '{}') });
    const mode = getMode();
    if (mode === 'bad_key') {
      return route.fulfill({ status: 401, headers: { ...CORS, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }) });
    }
    if (mode === 'slow') await new Promise((r) => setTimeout(r, 8000));
    const design = mode === 'fixed' ? { ...FIX, title: 'なおした紋' } : FIX;
    return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'text/event-stream' }, body: sseBody(design) }).catch(() => {});
  });
}

async function run() {
  let chromium;
  let devices;
  try {
    ({ chromium, devices } = require('playwright'));
  } catch (e) {
    console.error('playwright が必要です:  npm i -D playwright');
    process.exit(1);
  }

  const server = spawn(process.execPath, [path.join(ROOT, 'serve.js'), String(PORT)], {
    stdio: 'ignore'
  });
  await waitForServer();

  const browser = await chromium.launch(CHROMIUM ? { executablePath: CHROMIUM } : {});
  const errors = [];
  const PHONE = phoneDevice(devices);
  const watch = (page, name) => {
    page.on('pageerror', (e) => errors.push(name + ': ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/401|Failed to load resource/.test(m.text())) errors.push(name + ': ' + m.text()); });
  };

  try {
    // ------------------------------------------------ スマホで開く
    section('iPhone 16 Plus で開く');
    const context = await browser.newContext({ ...PHONE, serviceWorkers: 'block' });
    const phone = await context.newPage();
    watch(phone, 'スマホ');
    const calls = [];
    let mode = 'ok';
    await mockApi(phone, calls, () => mode);
    await phone.goto(URL);
    await phone.waitForFunction(() => window.__app);
    await phone.evaluate(() => window.__app.ready);
    ok(true, 'ページが開いて、画面のしくみが立ち上がる');

    const fit = await phone.evaluate(() => ({
      wide: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      title: document.querySelector('h1').textContent.trim(),
      ver: document.getElementById('ver').textContent,
      provider: window.__app.provider()
    }));
    ok(fit.wide <= 1, '横スクロールが出ない');
    ok(fit.title === '作図', `見出しが出ている (${fit.title})`);
    ok(/版 \d/.test(fit.ver), `版の番号が画面に出ている (${fit.ver})`);
    ok(fit.provider === 'key', `claude.ai の外では自分のキーで呼ぶ (${fit.provider})`);

    // ------------------------------------------------ キーが無いとき
    section('API キー');
    await phone.locator('#desc').fill('振り返って吠えるライオン');
    await phone.locator('#go').tap();
    await phone.waitForTimeout(200);
    const noKey = await phone.evaluate(() => ({ open: document.getElementById('settings').open, msg: document.getElementById('msg').textContent }));
    ok(noKey.open, 'キーが無いまま押すと、設定が開く');
    ok(/API キー/.test(noKey.msg), `何をすればよいか出る (${noKey.msg})`);
    ok(calls.length === 0, 'キーが無いときは API を呼ばない');

    await phone.locator('#apiKey').fill('sk-ant-test-123');
    await phone.locator('#keySave').tap();
    const saved = await phone.evaluate(() => ({ key: localStorage.getItem('sakuzu-api-key'), open: document.getElementById('settings').open }));
    ok(saved.key === 'sk-ant-test-123' && !saved.open, 'キーを保存すると、この端末に残って設定が閉じる');

    // ------------------------------------------------ 作図する
    section('作図する');
    await phone.locator('#go').tap();
    await phone.waitForFunction(() => /できました/.test(document.getElementById('msg').textContent), null, { timeout: 8000 });
    const c0 = calls[0] || { headers: {}, body: {} };
    ok(c0.headers['x-api-key'] === 'sk-ant-test-123', 'キーが x-api-key で送られる');
    ok(c0.headers['anthropic-dangerous-direct-browser-access'] === 'true', 'ブラウザから直接呼ぶ印が付く');
    ok(c0.body.model === 'claude-opus-5-5' && c0.body.stream === true, `モデルとストリーム (${c0.body.model})`);
    ok(c0.body.messages && c0.body.messages[0].content.includes('振り返って吠えるライオン'), '説明文が頼みに入る');

    const drawn = await phone.evaluate(() => {
      const g = window.__app.state().guides;
      return {
        gd: document.querySelectorAll('#stage .gd').length, want: g.circles.length + g.lines.length,
        shapes: document.querySelectorAll('#stage .mass path').length,
        hist: document.querySelectorAll('#hist button').length
      };
    });
    ok(drawn.gd === drawn.want && drawn.gd > 0, `補助線がすべて引かれる (${drawn.gd}/${drawn.want})`);
    ok(drawn.shapes === FIX.shapes.length, `形がすべて入る (${drawn.shapes})`);
    ok(drawn.hist === 1, 'これまでの作図に 1 つ増える');

    // アニメーションが本当に動いて終わるか。最後の線は 1100ms 遅れて 1s かかる。形は 1.25s 遅れて 0.9s
    await phone.waitForTimeout(2600);
    const anim = await phone.evaluate(() => {
      const gds = [...document.querySelectorAll('#stage .gd')];
      const off = Math.max(...gds.map((p) => Math.abs(parseFloat(getComputedStyle(p).strokeDashoffset) || 0)));
      return { off, mass: getComputedStyle(document.querySelector('#stage .mass')).opacity, fin: getComputedStyle(document.querySelector('#stage .fin')).opacity };
    });
    ok(anim.off < 0.01, `線が引き終わる (残り ${anim.off})`);
    ok(+anim.mass === 1 && +anim.fin === 1, `形が出そろう (${anim.mass} / ${anim.fin})`);

    // 画面からはみ出す物が無いか (430pt 決め打ち)
    const over = await phone.evaluate(() => [...document.querySelectorAll('.wrap *')]
      .filter((el) => el.offsetParent !== null && !el.closest('svg'))
      .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.left < -0.5 || r.right > innerWidth + 0.5); })
      .map((el) => el.id || el.className || el.tagName));
    ok(over.length === 0, over.length ? `画面の外へはみ出す: ${over.slice(0, 5).join(', ')}` : 'どの部品も画面の幅に収まる');

    // ------------------------------------------------ ロゴ・色
    section('ロゴと色');
    await phone.locator('#viewSeg button[data-v="logo"]').tap();
    const logo = await phone.evaluate(() => ({ vb: document.querySelector('#stage svg').getAttribute('viewBox'), gd: document.querySelectorAll('#stage .gd').length }));
    ok(logo.vb === '0 0 1000 1000' && logo.gd === 0, 'ロゴに切り替えると、補助線のないロゴになる');
    await phone.locator('#inks button').nth(2).tap();
    const ink = await phone.evaluate(() => [...document.querySelectorAll('#stage path')].map((p) => p.getAttribute('fill')));
    ok(ink.length > 0 && ink.every((f) => f === '#A8392B'), '色を選ぶと、ロゴの色が変わる');
    await phone.locator('#viewSeg button[data-v="sheet"]').tap();
    ok(await phone.evaluate(() => document.querySelectorAll('#stage .gd').length > 0), '設計図に戻せる');

    // ------------------------------------------------ なおす
    section('なおす');
    mode = 'fixed';
    await phone.locator('#fixText').fill('雫をもっと大きく');
    await phone.locator('#fixGo').tap();
    await phone.waitForFunction(() => window.__app.state().data.title === 'なおした紋', null, { timeout: 8000 });
    const fixPrompt = calls[calls.length - 1].body.messages[0].content;
    ok(fixPrompt.includes('雫をもっと大きく') && fixPrompt.includes(FIX.shapes[1]), 'なおす注文と、今の形が頼みに入る');
    ok(fixPrompt.includes('振り返って吠えるライオン'), 'もとの説明も残る');
    ok(await phone.evaluate(() => document.getElementById('fixText').value === ''), 'なおしたら入力欄が空になる');
    mode = 'ok';

    // ------------------------------------------------ 保存
    section('保存');
    const SAVES = [['sheet', 'なおした紋_設計図.svg', 'image/svg+xml'], ['svg', 'なおした紋.svg', 'image/svg+xml'], ['png', 'なおした紋.png', 'image/png']];
    // iPhone の本命: 共有シート (「画像を保存」「ファイルに保存」) へファイルを渡す
    await phone.evaluate(() => {
      window.__shared = [];
      navigator.canShare = (d) => !!(d && d.files);
      navigator.share = async (d) => { for (const f of d.files) window.__shared.push({ name: f.name, type: f.type, size: f.size }); };
    });
    for (const [kind] of SAVES) await phone.locator(`[data-save="${kind}"]`).tap();
    await phone.waitForFunction(() => window.__shared.length >= 3, null, { timeout: 5000 }).catch(() => {});
    const shared = await phone.evaluate(() => window.__shared);
    SAVES.forEach(([kind, name, type], i) => {
      const f = shared[i] || {};
      ok(f.name === name && f.type === type && f.size > 200, `${kind}: 共有シートへ渡る (${f.name}, ${f.type}, ${f.size}B)`);
    });
    if (shared[2]) {
      const png = await phone.evaluate(async () => {
        // PNG が 1600px 四方で、背景が透けているか (四隅が透明)
        const svg = window.Core.logoSVG(window.__app.state(), { transparent: true, size: 820 });
        const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); await img.decode();
        const cv = document.createElement('canvas'); cv.width = cv.height = 1600; const g = cv.getContext('2d'); g.drawImage(img, 0, 0, 1600, 1600);
        return { corner: g.getImageData(2, 2, 1, 1).data[3], mid: g.getImageData(800, 192, 1, 1).data[3] };
      });
      ok(png.corner === 0 && png.mid > 0, `PNG は背景が透けて、形は塗られている (隅 ${png.corner} / 輪 ${png.mid})`);
    }
    // 共有できない端末では、ダウンロードで渡す。
    // ヘッドレス Chromium は日本語の名前を "download" に置き換えるので、名前は <a download> の値で見る
    await phone.evaluate(() => {
      navigator.canShare = undefined;
      window.__named = [];
      const click = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () { window.__named.push(this.download); return click.call(this); };
    });
    for (const [kind, name] of SAVES) {
      const [dl] = await Promise.all([phone.waitForEvent('download', { timeout: 5000 }).catch(() => null), phone.locator(`[data-save="${kind}"]`).tap()]);
      let size = 0;
      if (dl) { const p = await dl.path(); size = p ? fs.statSync(p).size : 0; }
      const named = await phone.evaluate(() => window.__named[window.__named.length - 1]);
      ok(named === name && size > 200, `${kind}: ダウンロードで渡る (${named}, ${size}B)`);
    }

    // ------------------------------------------------ 止める・失敗
    section('止める・失敗したとき');
    mode = 'slow';
    await phone.locator('#go').tap();
    await phone.waitForFunction(() => document.getElementById('status').classList.contains('busy'));
    ok(await phone.locator('#stop').isVisible(), '作図中は「止める」が出る');
    await phone.locator('#stop').tap();
    await phone.waitForFunction(() => /止めました/.test(document.getElementById('msg').textContent), null, { timeout: 3000 }).catch(() => {});
    const stopped = await phone.evaluate(() => ({ msg: document.getElementById('msg').textContent, go: document.getElementById('go').disabled }));
    ok(/止めました/.test(stopped.msg) && !stopped.go, `止められて、また押せる (${stopped.msg})`);

    mode = 'bad_key';
    await phone.locator('#go').tap();
    await phone.waitForFunction(() => /キーが通りません/.test(document.getElementById('msg').textContent), null, { timeout: 5000 }).catch(() => {});
    const bad = await phone.evaluate(() => ({ msg: document.getElementById('msg').textContent, open: document.getElementById('settings').open, title: window.__app.state().data.title }));
    ok(/キーが通りません/.test(bad.msg), `キーが違うと、そう出る (${bad.msg})`);
    ok(bad.open, 'キーが違うと、設定が開く');
    ok(bad.title === 'なおした紋', '失敗しても、前の作図は消えない');
    await phone.evaluate(() => document.getElementById('settings').close());
    mode = 'ok';

    // ------------------------------------------------ 開き直す
    section('開き直す');
    await phone.reload();
    await phone.waitForFunction(() => window.__app);
    const hist = await phone.evaluate(() => document.querySelectorAll('#hist button').length);
    ok(hist === 2, `これまでの作図が残る (${hist})`);
    await phone.locator('#hist button').nth(1).tap();
    const reopened = await phone.evaluate(() => ({
      title: window.__app.state().data.title, desc: document.getElementById('desc').value,
      gd: document.querySelectorAll('#stage .gd').length
    }));
    ok(reopened.title === FIX.title && reopened.desc === '振り返って吠えるライオン' && reopened.gd > 0, '押すと、その作図と説明が戻る');
    // 小窓の枠: 形の外接矩形に 10% の余白。形が小窓の真ん中に来る
    const thumb = await phone.evaluate(() => {
      const svg = document.querySelector('#hist button svg');
      const vb = svg.getAttribute('viewBox').split(' ').map(Number);
      return { cx: vb[0] + vb[2] / 2, cy: vb[1] + vb[3] / 2 };
    });
    ok(Math.abs(thumb.cx - 530) < 1 && Math.abs(thumb.cy - 470) < 1, `小窓は形の真ん中を向く (${thumb.cx}, ${thumb.cy})`);
    await context.close();

    // ------------------------------------------------ claude.ai の中で開いたとき
    section('claude.ai の中で開いたとき (キーなし)');
    const inCtx = await browser.newContext({ ...PHONE, serviceWorkers: 'block' });
    await inCtx.addInitScript((fix) => {
      window.__asked = []; window.__saved = [];
      window.claude = {
        use: async (name) => name === 'sample'
          ? { json: async (prompt, opts) => { window.__asked.push({ prompt, opts }); return fix; } }
          : { save: async (o) => { window.__saved.push({ filename: o.filename, kind: typeof o.data }); } }
      };
    }, FIX);
    const inPage = await inCtx.newPage();
    watch(inPage, 'claude.ai');
    const inCalls = [];
    await mockApi(inPage, inCalls, () => 'ok');
    await inPage.goto(URL);
    await inPage.waitForFunction(() => window.__app);
    await inPage.evaluate(() => window.__app.ready);
    ok(await inPage.evaluate(() => window.__app.provider()) === 'claude', 'claude.ai の中だと sample で呼ぶ');
    await inPage.locator('#desc').fill('鶴');
    await inPage.locator('#tierSeg button[data-v="complex"]').tap();
    await inPage.locator('#go').tap();
    await inPage.waitForFunction(() => /できました/.test(document.getElementById('msg').textContent), null, { timeout: 5000 });
    const asked = await inPage.evaluate(() => window.__asked[0]);
    ok(asked && asked.opts.modelTier === 'complex' && asked.prompt.includes('鶴'), 'キーなしで作図でき、「ていねい」が渡る');
    ok(inCalls.length === 0, 'API へは直接行かない');
    await inPage.locator('[data-save="svg"]').tap();
    await inPage.waitForTimeout(200);
    const savedIn = await inPage.evaluate(() => window.__saved);
    ok(savedIn.length === 1 && savedIn[0].filename.endsWith('.svg'), 'claude.ai の保存のしくみで書き出す');
    await inPage.locator('#openSettings').tap();
    ok(await inPage.locator('#apiKey').isHidden(), '設定にキーの欄は出ない');
    await inCtx.close();

    // ------------------------------------------------ 黄金比
    section('黄金比');
    const gCtx = await browser.newContext({ ...PHONE, serviceWorkers: 'block' });
    await gCtx.addInitScript((g) => {
      window.__asked = [];
      window.claude = { use: async (name) => name === 'sample' ? { json: async (prompt) => { window.__asked.push(prompt); return g; } } : null };
    }, FIX.golden);
    const gPage = await gCtx.newPage();
    watch(gPage, '黄金比');
    await gPage.goto(URL);
    await gPage.waitForFunction(() => window.__app);
    await gPage.evaluate(() => window.__app.ready);
    const ratioSeg = await gPage.evaluate(() => {
      const r = document.getElementById('ratioSeg').getBoundingClientRect();
      return { right: r.right, w: innerWidth, on: document.querySelector('#ratioSeg [aria-pressed="true"]').dataset.v };
    });
    ok(ratioSeg.right <= ratioSeg.w && ratioSeg.on === 'free', `「比率」の段が画面に収まり、はじめは自由 (右端 ${Math.round(ratioSeg.right)}/${ratioSeg.w})`);
    await gPage.locator('#desc').fill('鶴');
    await gPage.locator('#ratioSeg button[data-v="golden"]').tap();
    await gPage.locator('#go').tap();
    await gPage.waitForFunction(() => /できました/.test(document.getElementById('msg').textContent), null, { timeout: 5000 });
    const gRes = await gPage.evaluate(() => ({
      asked: window.__asked[0], msg: document.getElementById('msg').textContent,
      phi: document.querySelectorAll('#stage .gd.phi').length,
      note: (document.querySelector('#stage .phinote') || {}).textContent || ''
    }));
    ok(gRes.asked.includes('golden ratio'), '黄金比を選ぶと、頼みに黄金比の指示が入る');
    ok(gRes.phi === 3, `黄金比の組に入る円が金茶で引かれる (${gRes.phi})`);
    ok(/φ 黄金比 2組/.test(gRes.note), `設計図に組の数が書き添えられる (${gRes.note})`);
    ok(/φ2組/.test(gRes.msg), `できたときの知らせにも出る (${gRes.msg})`);
    // 段を自由に戻しても、なおすときはもとの作図の比率を引き継ぐ
    await gPage.locator('#ratioSeg button[data-v="free"]').tap();
    await gPage.locator('#fixText').fill('翼を大きく');
    await gPage.locator('#fixGo').tap();
    await gPage.waitForFunction(() => window.__asked.length === 2, null, { timeout: 5000 });
    ok(await gPage.evaluate(() => window.__asked[1].includes('golden ratio')), 'なおすときは、もとの作図の黄金比を引き継ぐ');
    await gPage.locator('#desc').fill('亀');
    await gPage.locator('#go').tap();
    await gPage.waitForFunction(() => window.__asked.length === 3, null, { timeout: 5000 });
    ok(await gPage.evaluate(() => !window.__asked[2].includes('golden ratio')), '自由に戻して作図すると、指示は入らない');
    // これまでの作図から開くと、比率の段もその作図のものに戻る
    await gPage.reload();
    await gPage.waitForFunction(() => window.__app);
    await gPage.locator('#hist button').last().tap();
    ok(await gPage.evaluate(() => document.querySelector('#ratioSeg [aria-pressed="true"]').dataset.v) === 'golden', '黄金比で作った物を開くと、比率の段も黄金比に戻る');
    await gCtx.close();

    // ------------------------------------------------ 明るい画面・暗い画面
    section('明るい画面と暗い画面');
    for (const scheme of ['light', 'dark']) {
      const themed = await browser.newContext({ ...PHONE, colorScheme: scheme, serviceWorkers: 'block' });
      const page = await themed.newPage();
      page.on('pageerror', (e) => errors.push(scheme + ': ' + e.message));
      await page.goto(URL);
      await page.waitForFunction(() => window.__app);
      const colors = await page.evaluate(() => ({
        bg: getComputedStyle(document.body).backgroundColor,
        fg: getComputedStyle(document.body).color
      }));
      ok(colors.bg !== colors.fg, `${scheme}: 文字と背景の色が違う (${colors.bg} / ${colors.fg})`);
      await themed.close();
    }

    // ------------------------------------------------ アイコン
    section('アイコン');
    const desk = await browser.newPage();
    await desk.goto(URL);
    const apple = await desk.evaluate(() =>
      document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href'));
    if (!apple) {
      skip('ホーム画面用のアイコンはまだ無い');
    } else {
      // iOS は SVG のアイコンを使えない
      ok(apple.endsWith('.png'), `ホーム画面用アイコンが PNG (${apple})`);
      const res = await desk.request.get(URL + apple.replace('./', ''));
      ok(res.ok(), `${apple} が配信される`);
    }
    await desk.close();

    // ------------------------------------------------ 更新とオフライン
    section('更新とオフライン');
    if (!fs.existsSync(path.join(ROOT, 'sw.js'))) {
      skip('サービスワーカーはまだ無い');
    } else {
      const swCtx = await browser.newContext();
      const swPage = await swCtx.newPage();
      await swPage.goto(URL);
      await swPage.waitForFunction(() => window.__app);
      ok(await swPage.evaluate(() => navigator.serviceWorker.ready.then((r) => !!r.active).catch(() => false)),
        'サービスワーカーが動く');
      await swPage.waitForTimeout(800);

      // 直したものが 1 回のリロードで出るか (キャッシュ優先だと古い画面が出る)
      const indexPath = path.join(ROOT, 'index.html');
      const original = fs.readFileSync(indexPath, 'utf8');
      const marker = original.match(/<h1[^>]*>([^<]*)<\/h1>/);
      fs.writeFileSync(indexPath, original.replace(marker[0], marker[0].replace(marker[1], 'こうしんかくにん')));
      await swPage.reload();
      await swPage.waitForTimeout(400);
      const title = await swPage.textContent('h1');
      fs.writeFileSync(indexPath, original);
      ok(title.trim() === 'こうしんかくにん', `直したものが 1 回のリロードで出る (${title.trim()})`);

      await swPage.reload();
      await swPage.waitForTimeout(500);
      await swCtx.setOffline(true);
      await swPage.reload().catch(() => {});
      await swPage.waitForTimeout(400);
      ok(await swPage.evaluate(() => !!window.__app).catch(() => false),
        'ネットにつながらなくても開ける');
      await swCtx.setOffline(false);
      await swCtx.close();
    }

    section('エラー');
    ok(errors.length === 0, errors.length ? '画面のエラー: ' + errors.join(' / ') : 'JS エラーなし');
  } finally {
    await browser.close();
    server.kill();
  }

  console.log(`\n${passed} 件合格 / ${failed} 件失敗`);
  process.exit(failed ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
