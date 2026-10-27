/*!
 * app.js — 画面まわり。操作と描画はここに書く。
 *
 * 作図を頼む先は 2 通り:
 *   - claude.ai の中で開いたとき: window.claude の sample (キー不要)
 *   - それ以外: 設定で入れた自分の Anthropic API キーで、ブラウザから直接
 */
(function () {
  'use strict';

  const C = window.Core;
  const VERSION = '0.1.0';
  const $ = (id) => document.getElementById(id);

  const S = {
    data: null, guides: null, bbox: null, ink: C.INKS[0].c, view: 'sheet', frame: 'auto', tier: 'default',
    busy: false, ctl: null, brand: '', desc: '', lastPrompt: null
  };
  // provider: 'claude' (claude.ai の中) / 'key' (自分のキー) / null (まだ決まっていない)
  let provider = null, sample = null, downloads = null;

  /* ---------- 保存 (この端末だけ) ---------- */
  const KEY_K = 'sakuzu-api-key';
  const HK = 'sakuzu-history-v1';
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* 無視 */ } }
  };
  const apiKey = () => (store.get(KEY_K) || '').trim();

  const setMsg = (t, busy) => { $('msg').textContent = t; $('status').classList.toggle('busy', !!busy); };

  function segInit(id, key, after) {
    $(id).addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      [...$(id).children].forEach((x) => x.setAttribute('aria-pressed', x === b));
      S[key] = b.dataset.v; if (after) after();
    });
  }
  const pressView = () => [...$('viewSeg').children].forEach((x) => x.setAttribute('aria-pressed', x.dataset.v === S.view));
  const pressInk = () => [...$('inks').children].forEach((x, i) => x.setAttribute('aria-pressed', C.INKS[i].c === S.ink));

  /* ---------- 描画 ---------- */
  function render(animate) {
    if (!S.data) return;
    $('stage').innerHTML = S.view === 'sheet' ? C.sheetSVG(S, animate) : C.logoSVG(S);
    $('tools').classList.add('on'); $('fix').classList.add('on'); $('saves').classList.add('on');
  }

  function show(data) {
    S.data = data; S.guides = C.buildGuides(data); S.bbox = C.pathBBox(data.shapes);
    S.view = 'sheet'; pressView();
    render(true);
  }

  /* ---------- 頼む ---------- */
  const ERR = {
    no_key: '設定で API キーを入れてください。',
    bad_key: 'API キーが通りませんでした。設定で確かめてください。',
    forbidden: 'このキーでは使えないモデルか、権限がありません。',
    not_granted: 'このページからClaudeを呼ぶ許可がありません。', sampling_disabled: 'このアカウントではAI作図が使えません。',
    rate_limited: '混み合っています。少し待ってからもう一度押してください。',
    overloaded: 'Claude が混み合っています。少し待ってからもう一度。',
    refused: 'この内容では作図できませんでした。説明を変えてください。',
    invalid_json: '図形データを読み取れませんでした。もう一度作図してください。',
    truncated: '図形が長くなりすぎて途中で切れました。もう少し簡単な説明で。',
    empty_completion: '答えが空でした。説明を少し短くしてもう一度。',
    empty_shapes: '形が返ってきませんでした。もう一度作図してください。',
    session_expired: 'ログインし直してください。', prompt_too_large: '説明が長すぎます。短くしてください。',
    offline: 'ネットにつながっていません。'
  };
  const FATAL = ['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed'];

  /** 自分のキーで Anthropic API を呼ぶ。返事は途中経過を見せながら受け取る */
  async function callApi(prompt, tier, signal, onProgress) {
    const key = apiKey();
    if (!key) throw { code: 'no_key' };
    if (navigator.onLine === false) throw { code: 'offline' };
    const req = C.buildRequest(key, prompt, tier);
    let res;
    try {
      res = await fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal });
    } catch (e) {
      if (e && e.name === 'AbortError') throw { code: 'cancelled' };
      throw { code: 'network' };
    }
    if (!res.ok) {
      let type = '', detail = '';
      try { const j = await res.json(); type = j.error && j.error.type; detail = j.error && j.error.message; } catch (e) { /* 本文なし */ }
      throw { code: C.apiErrorCode(res.status, type), detail };
    }
    const sr = C.createStreamReader();
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        sr.feed(dec.decode(value, { stream: true }));
        if (onProgress) onProgress(sr.result.text.length);
      }
      sr.feed(dec.decode() + '\n\n');
    } catch (e) {
      if (e && e.name === 'AbortError') throw { code: 'cancelled' };
      throw { code: 'network' };
    }
    const r = sr.result;
    if (r.error) throw { code: C.apiErrorCode(0, r.error.type), detail: r.error.message };
    if (r.stop === 'refusal') throw { code: 'refused' };
    if (r.stop === 'max_tokens') throw { code: 'truncated' };
    if (!r.text.trim()) throw { code: 'empty_completion' };
    return C.extractJSON(r.text);
  }

  async function ask(prompt, tier, signal, onProgress) {
    if (provider === 'claude') return sample.json(prompt, { modelTier: tier, signal, cache: false });
    return callApi(prompt, tier, signal, onProgress);
  }

  async function generate(fixText) {
    if (S.busy) return;
    const desc = fixText ? S.desc : $('desc').value.trim();
    if (!desc) { setMsg('どんなロゴにしたいか、ひとこと書いてください。'); $('desc').focus(); return; }
    if (provider !== 'claude' && !apiKey()) { setMsg(ERR.no_key); openSettings(); return; }
    S.busy = true; $('go').disabled = true; $('fixGo').disabled = true;
    S.ctl = new AbortController();
    const t0 = Date.now();
    const label = fixText ? 'なおしています' : '円と線を引いています';
    let got = 0;
    const line = () => `${label}… ${Math.round((Date.now() - t0) / 1000)}秒${got ? `・${(got / 1000).toFixed(1)}k字` : ''}`;
    setMsg(line(), true);
    const tick = setInterval(() => setMsg(line(), true), 1000);
    try {
      const prompt = C.buildPrompt(desc, S.frame, fixText, fixText ? S.data : null);
      S.lastPrompt = prompt;
      const raw = await ask(prompt, S.tier, S.ctl.signal, (n) => { got = n; });
      const data = C.normalize(raw);
      if (!fixText) { S.desc = desc; S.brand = $('brand').value.trim(); }
      show(data);
      pushHistory();
      setMsg(`できました(${Math.round((Date.now() - t0) / 1000)}秒・円${S.guides.circles.length}・線${S.guides.lines.length})`);
      if (fixText) $('fixText').value = '';
    } catch (e) {
      const code = e && (e.code || (e.name === 'AbortError' && 'cancelled'));
      if (code === 'cancelled') setMsg('止めました。');
      else setMsg((ERR[code] || '通信がとぎれました。もう一度作図してください。') + (e && e.detail ? `(${String(e.detail).slice(0, 120)})` : ''));
      if (code === 'bad_key') openSettings();
      if (provider === 'claude' && FATAL.includes(code)) { sample = null; useKeyMode(); }
    } finally {
      clearInterval(tick); S.busy = false; S.ctl = null;
      $('go').disabled = false; $('fixGo').disabled = false;
      $('status').classList.remove('busy');
    }
  }

  /* ---------- これまでの作図 ---------- */
  const loadH = () => { try { const h = JSON.parse(store.get(HK) || '[]'); return Array.isArray(h) ? h : []; } catch (e) { return []; } };
  function pushHistory() {
    const h = loadH();
    h.unshift({ t: Date.now(), desc: S.desc, brand: S.brand, ink: S.ink, data: S.data, bbox: S.bbox });
    store.set(HK, JSON.stringify(h.slice(0, 16)));
    drawHistory();
  }
  function openItem(item) {
    S.desc = item.desc || ''; S.brand = item.brand || ''; S.ink = item.ink || C.INKS[0].c;
    $('desc').value = S.desc; $('brand').value = S.brand; pressInk();
    show(item.data);
    setMsg(''); $('stage').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function drawHistory() {
    const h = loadH().filter((it) => it && it.data && Array.isArray(it.data.shapes));
    $('histSec').hidden = !h.length;
    $('hist').innerHTML = '';
    h.forEach((item) => {
      const b = document.createElement('button');
      b.type = 'button';
      const bb = item.bbox || C.pathBBox(item.data.shapes);
      const vb = bb ? C.padBox(bb, .1) : '200 200 600 600';
      b.innerHTML = `<svg viewBox="${vb}" aria-hidden="true">${C.massPaths(item.data, item.ink || C.INKS[0].c)}</svg>`;
      b.setAttribute('aria-label', (item.brand || item.data.title || 'ロゴ') + ' を開く');
      b.onclick = () => openItem(item);
      $('hist').appendChild(b);
    });
  }

  /* ---------- 書き出し ---------- */
  async function svgToPng(svg, size) {
    const img = new Image();
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    await new Promise((ok, ng) => { img.onload = ok; img.onerror = ng; img.src = url; });
    const cv = document.createElement('canvas'); cv.width = cv.height = size;
    cv.getContext('2d').drawImage(img, 0, 0, size, size);
    return new Promise((ok) => cv.toBlob(ok, 'image/png'));
  }

  /** 端末へ渡す。iPhone では共有シートから「画像を保存」できる */
  async function handOver(filename, blob) {
    const file = typeof File === 'function' ? new File([blob], filename, { type: blob.type }) : null;
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file] }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  async function save(kind) {
    if (!S.data) return;
    let name, blob;
    if (kind === 'sheet') { name = C.fileName(S, '_設計図.svg'); blob = new Blob([C.sheetSVG(S, false)], { type: 'image/svg+xml' }); }
    else if (kind === 'svg') { name = C.fileName(S, '.svg'); blob = new Blob([C.logoSVG(S, { transparent: true, size: 820 })], { type: 'image/svg+xml' }); }
    else { name = C.fileName(S, '.png'); blob = await svgToPng(C.logoSVG(S, { transparent: true, size: 820 }), 1600); }
    try {
      if (downloads) await downloads.save({ filename: name, data: kind === 'png' ? blob : await blob.text() });
      else await handOver(name, blob);
    } catch (e) {
      const c = e && e.code;
      if (c === 'declined') return;
      if (downloads && ['unavailable', 'not_granted', 'capability_disabled', 'capability_removed'].includes(c)) { downloads = null; return save(kind); }
      setMsg(c === 'rate_limited' ? '保存の確認が開いています。少し待ってから。' : '保存できませんでした。');
    }
  }

  /* ---------- 設定 ---------- */
  function openSettings() {
    $('apiKey').value = apiKey();
    $('keyArea').hidden = provider === 'claude';
    $('keyClear').hidden = $('keySave').hidden = provider === 'claude';
    $('setMode').textContent = provider === 'claude'
      ? 'claude.ai の中で開いているので、キーなしで作図できます。'
      : (apiKey() ? 'API キーは保存されています。' : '作図には Anthropic の API キーが要ります。');
    const d = $('settings');
    if (typeof d.showModal === 'function') { if (!d.open) d.showModal(); } else d.setAttribute('open', '');
  }
  const closeSettings = () => { const d = $('settings'); if (d.open) d.close ? d.close() : d.removeAttribute('open'); };

  function useKeyMode() {
    provider = 'key';
    if (!apiKey()) setMsg('はじめに「設定」で API キーを入れてください。');
  }

  async function detectProvider() {
    const W = window.claude;
    if (W && W.use) {
      W.use('downloads').then((d) => { downloads = d; }).catch(() => {});
      try { sample = await W.use('sample'); } catch (e) { sample = null; }
      if (sample) { provider = 'claude'; return; }
    }
    useKeyMode();
  }

  /* ---------- 立ち上げ ---------- */
  function main() {
    segInit('frameSeg', 'frame');
    segInit('tierSeg', 'tier');
    segInit('viewSeg', 'view', () => render(false));

    C.INKS.forEach((k, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.style.background = k.c; b.setAttribute('aria-label', k.n); b.title = k.n;
      b.setAttribute('aria-pressed', i === 0);
      b.onclick = () => { S.ink = k.c; pressInk(); render(false); };
      $('inks').appendChild(b);
    });

    $('go').onclick = () => generate(null);
    $('stop').onclick = () => { if (S.ctl) S.ctl.abort(); };
    $('fixGo').onclick = () => { const t = $('fixText').value.trim(); if (t) generate(t); else $('fixText').focus(); };
    $('fixText').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); $('fixGo').click(); } });
    $('saves').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) save(b.dataset.save); });

    $('openSettings').onclick = openSettings;
    $('keySave').onclick = () => {
      const v = $('apiKey').value.trim();
      if (v) store.set(KEY_K, v); else store.del(KEY_K);
      closeSettings(); setMsg(v ? 'API キーを保存しました。' : '');
    };
    $('keyClear').onclick = () => { store.del(KEY_K); $('apiKey').value = ''; closeSettings(); setMsg('API キーを消しました。'); };

    $('ver').textContent = `版 ${VERSION}`;
    drawHistory();
    const ready = detectProvider();

    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol) && !window.claude) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }

    // 自動テストから中身をのぞくための入口
    window.__app = {
      version: VERSION,
      ready,
      state: () => S,
      provider: () => provider,
      generate,
      show,
      render,
      save,
      openSettings
    };
  }

  main();
})();
