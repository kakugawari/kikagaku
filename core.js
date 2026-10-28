/*!
 * core.js — 作図のロジック。DOM を触らないので node でテストできる。
 *
 * ブラウザでは <script> で読み込むと window.Core になり、
 * node からは require() できる。
 *
 * 流れ: 説明文 → buildPrompt → (Claude) → normalize → buildGuides / pathBBox
 *       → sheetSVG(設計図) / logoSVG(ロゴ) の文字列
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = factory();
  } else {
    root.Core = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const INKS = [
    { c: '#48443A', n: '墨茶' }, { c: '#22385A', n: '藍' }, { c: '#A8392B', n: '朱' }, { c: '#1C1B1A', n: '墨' }
  ];

  /* ---------- 小さな道具 ---------- */
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const num = (v) => typeof v === 'number' && isFinite(v);
  const r1 = (v) => Math.round(v * 10) / 10;

  /* ---------- パス: 頂点・弧・線分 ---------- */
  function cleanD(d) { return String(d || '').replace(/[^MLHVAZmlhvaz0-9.,\s\-+eE]/g, ' ').slice(0, 30000); }

  function parsePath(d) {
    const tk = d.match(/[MLHVAZmlhvaz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) || [];
    let i = 0, cmd = '', x = 0, y = 0, sx = 0, sy = 0;
    const verts = [], arcs = [], segs = [];
    const isCmd = (t) => /^[A-Za-z]$/.test(t);
    const n = () => parseFloat(tk[i++]);
    while (i < tk.length) {
      if (isCmd(tk[i])) cmd = tk[i++];
      if (!cmd) { i++; continue; }
      const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
      if (C === 'Z') { segs.push([x, y, sx, sy]); x = sx; y = sy; cmd = ''; continue; }
      if (i >= tk.length || isCmd(tk[i])) { continue; }
      if (C === 'M') { let nx = n(), ny = n(); if (rel) { nx += x; ny += y; } x = sx = nx; y = sy = ny; verts.push([x, y]); cmd = rel ? 'l' : 'L'; }
      else if (C === 'L') { let nx = n(), ny = n(); if (rel) { nx += x; ny += y; } segs.push([x, y, nx, ny]); x = nx; y = ny; verts.push([x, y]); }
      else if (C === 'H') { let nx = n(); if (rel) nx += x; segs.push([x, y, nx, y]); x = nx; verts.push([x, y]); }
      else if (C === 'V') { let ny = n(); if (rel) ny += y; segs.push([x, y, x, ny]); y = ny; verts.push([x, y]); }
      else if (C === 'A') {
        const rx = n(), ry = n(); n(); const fa = n(), fs = n(); let nx = n(), ny = n();
        if (rel) { nx += x; ny += y; }
        arcs.push({ x1: x, y1: y, r: (Math.abs(rx) + Math.abs(ry)) / 2, fa, fs, x2: nx, y2: ny });
        x = nx; y = ny; verts.push([x, y]);
      } else { i++; }
      if (![x, y].every(isFinite)) break;
    }
    return { verts, arcs, segs };
  }

  /** 弧の中心と半径 (SVG 仕様の端点→中心変換。回転 0 の真円として扱う) */
  function arcCenter(a) {
    let r = a.r; if (!(r > 0)) return null;
    const dx = (a.x1 - a.x2) / 2, dy = (a.y1 - a.y2) / 2, d2 = dx * dx + dy * dy;
    if (d2 < 1e-6) return null;
    const lam = d2 / (r * r); if (lam > 1) r *= Math.sqrt(lam);
    const sign = (a.fa === a.fs) ? -1 : 1;
    const k = sign * Math.sqrt(Math.max(0, (r * r - d2) / d2));
    return { cx: k * dy + (a.x1 + a.x2) / 2, cy: -k * dx + (a.y1 + a.y2) / 2, r };
  }

  /**
   * 図形全体の外接矩形。弧のふくらみ (上下左右の端) まで含める。
   * 画面で getBBox を測らずに済むので、履歴の小窓も保存も同じ枠になる。
   */
  function pathBBox(shapes) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const add = (x, y) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
    const TAU = Math.PI * 2;
    const norm = (t) => ((t % TAU) + TAU) % TAU;
    shapes.forEach((d) => {
      const p = parsePath(d);
      p.verts.forEach(([x, y]) => add(x, y));
      p.arcs.forEach((a) => {
        const c = arcCenter(a); if (!c) return;
        const t1 = Math.atan2(a.y1 - c.cy, a.x1 - c.cx), t2 = Math.atan2(a.y2 - c.cy, a.x2 - c.cx);
        // fs=1 は角度が増える向き (y 下向きの画面で時計回り)
        const span = a.fs ? norm(t2 - t1) : norm(t1 - t2);
        for (let q = 0; q < 4; q++) {
          const t = q * Math.PI / 2;
          const off = a.fs ? norm(t - t1) : norm(t1 - t);
          if (off <= span) add(c.cx + c.r * Math.cos(t), c.cy + c.r * Math.sin(t));
        }
      });
    });
    if (!(x1 >= x0 && y1 >= y0)) return null;
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }

  /* ---------- 黄金比 ---------- */
  const PHI = (1 + Math.sqrt(5)) / 2;
  const PHI_TOL = 0.015;   // 比が φ から 1.5% 以内なら黄金比とみなす (半径は整数や小数 1 桁に丸めて返ってくる)

  /**
   * 円の半径どうしで、比が黄金比になっている組を探す。
   * 同じ半径の円は 1 つにまとめて数える。返すのは小さい順の組 [{a, b, ratio}]
   */
  function goldenPairs(circles) {
    const radii = [];
    (circles || []).forEach((c) => {
      if (!c || !num(c.r) || c.r <= 0) return;
      if (!radii.some((r) => Math.abs(r - c.r) <= Math.max(0.5, r * 0.002))) radii.push(c.r);
    });
    radii.sort((x, y) => x - y);
    const pairs = [];
    for (let i = 0; i < radii.length; i++) {
      for (let j = i + 1; j < radii.length; j++) {
        const ratio = radii[j] / radii[i];
        if (Math.abs(ratio / PHI - 1) <= PHI_TOL) pairs.push({ a: radii[i], b: radii[j], ratio });
      }
    }
    return pairs;
  }

  /** その円が、黄金比の組のどれかに入っているか */
  const inGolden = (c, pairs) => pairs.some((p) => [p.a, p.b].some((r) => Math.abs(r - c.r) <= Math.max(0.5, r * 0.002)));

  /** 設計図に引く補助線: 宣言された円と線 + 弧から逆算した円 + 長い辺の延長 */
  function buildGuides(data) {
    const circles = [], lines = [], crosses = [];
    const addC = (c, derived) => {
      if (!c || !num(c.cx) || !num(c.cy) || !num(c.r) || c.r < 6 || c.r > 2500) return;
      if (circles.some((o) => Math.abs(o.cx - c.cx) < 7 && Math.abs(o.cy - c.cy) < 7 && Math.abs(o.r - c.r) < 7)) return;
      circles.push({ cx: c.cx, cy: c.cy, r: c.r });
      if (derived && c.r > 14) crosses.push([c.cx, c.cy]);
    };
    (data.circles || []).forEach((c) => addC(c, false));
    const allSegs = [], verts = [];
    data.shapes.forEach((d) => {
      const p = parsePath(d);
      p.arcs.forEach((a) => addC(arcCenter(a), true));
      allSegs.push(...p.segs); verts.push(...p.verts);
    });
    const addL = (x1, y1, x2, y2) => {
      const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy); if (L < 1) return;
      const ux = dx / L, uy = dy / L, ang = Math.atan2(uy, ux) % Math.PI, off = x1 * uy - y1 * ux;
      if (lines.some((o) => Math.abs(o.ang - ang) < .03 && Math.abs(o.off - off) < 8)) return;
      lines.push({ ang, off, x1: x1 - ux * 3000, y1: y1 - uy * 3000, x2: x1 + ux * 3000, y2: y1 + uy * 3000 });
    };
    (data.lines || []).forEach((l) => { if ([l.x1, l.y1, l.x2, l.y2].every(num)) addL(l.x1, l.y1, l.x2, l.y2); });
    allSegs.map((s) => ({ s, L: Math.hypot(s[2] - s[0], s[3] - s[1]) })).filter((o) => o.L > 55)
      .sort((a, b) => b.L - a.L).slice(0, 16).forEach((o) => addL(...o.s));
    const kept = circles.slice(0, 60);
    return { circles: kept, lines: lines.slice(0, 40), crosses: crosses.slice(0, 30), verts: verts.slice(0, 400), golden: goldenPairs(kept) };
  }

  /* ---------- 描画 (SVG の文字列を作る) ---------- */
  const circD = (c) => `M${r1(c.cx - c.r)} ${r1(c.cy)}A${r1(c.r)} ${r1(c.r)} 0 1 0 ${r1(c.cx + c.r)} ${r1(c.cy)}A${r1(c.r)} ${r1(c.r)} 0 1 0 ${r1(c.cx - c.r)} ${r1(c.cy)}Z`;
  const massPaths = (data, fill, extra = '') => data.shapes.map((d) => `<path d="${esc(d)}" fill="${fill}" fill-rule="evenodd" ${extra}/>`).join('');

  function wrapJa(text, n, max) {
    const out = []; let s = String(text || '').replace(/\s+/g, ' ').trim();
    while (s && out.length < max) { out.push(s.slice(0, n)); s = s.slice(n); }
    if (s && out.length) out[out.length - 1] = out[out.length - 1].slice(0, n - 1) + '…';
    return out;
  }

  function padBox(b, p) {
    const s = Math.max(b.width, b.height) * (1 + p * 2), cx = b.x + b.width / 2, cy = b.y + b.height / 2;
    return `${r1(cx - s / 2)} ${r1(cy - s / 2)} ${r1(s)} ${r1(s)}`;
  }

  /** 設計図。st = { data, guides, bbox, ink, brand } */
  function sheetSVG(st, animate) {
    const { data, guides: g, ink } = st;
    const guideInk = '#5F5B52';
    let k = 0;
    const delay = () => `style="--d:${Math.min(k++ * 22, 1100)}ms"`;
    const golden = g.golden || [];
    // 黄金比の組に入る円は金茶で引く
    const gc = g.circles.map((c) => inGolden(c, golden)
      ? `<path class="gd phi" pathLength="1" d="${circD(c)}" stroke="${PHI_INK}" stroke-opacity=".9" stroke-width="2.6" ${delay()}/>`
      : `<path class="gd" pathLength="1" d="${circD(c)}" ${delay()}/>`).join('');
    const phiNote = golden.length
      ? `<text class="phinote" x="500" y="142" text-anchor="middle" font-family="'Shippori Mincho',serif" font-size="17" fill="${PHI_INK}" letter-spacing="1">φ 黄金比 ${golden.length}組 ― ${esc(golden.slice(0, 3).map((p) => `r${Math.round(p.a)} : r${Math.round(p.b)}`).join(' · '))}${golden.length > 3 ? ' …' : ''}</text>`
      : '';
    const gl = g.lines.map((l) => `<path class="gd" pathLength="1" d="M${r1(l.x1)} ${r1(l.y1)}L${r1(l.x2)} ${r1(l.y2)}" ${delay()}/>`).join('');
    const cr = g.crosses.map(([x, y]) => `<path d="M${r1(x - 7)} ${r1(y)}H${r1(x + 7)}M${r1(x)} ${r1(y - 7)}V${r1(y + 7)}"/>`).join('');
    const dots = g.verts.map(([x, y]) => `<circle cx="${r1(x)}" cy="${r1(y)}" r="2.6"/>`).join('');
    const title = st.brand || data.title || '';
    const lines = wrapJa(data.concept, 27, 4);
    const bb = st.bbox ? padBox(st.bbox, .14) : '200 200 600 600';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1250" class="${animate ? 'draw' : ''}" role="img" aria-label="${esc(title)} の作図">
<defs>
  <linearGradient id="paper" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F3F2ED"/><stop offset=".55" stop-color="#ECEAE3"/><stop offset="1" stop-color="#D3CFC6"/></linearGradient>
  <pattern id="gMin" width="10" height="10" patternUnits="userSpaceOnUse"><path d="M10 0H0V10" fill="none" stroke="#6F6A5E" stroke-opacity=".10" stroke-width=".6"/></pattern>
  <pattern id="gMaj" width="50" height="50" patternUnits="userSpaceOnUse"><rect width="50" height="50" fill="url(#gMin)"/><path d="M50 0H0V50" fill="none" stroke="#6F6A5E" stroke-opacity=".16" stroke-width=".8"/></pattern>
  <linearGradient id="fadeG" gradientUnits="userSpaceOnUse" x1="0" y1="40" x2="0" y2="990"><stop offset="0" stop-color="#fff"/><stop offset=".7" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient>
  <mask id="fade"><rect x="0" y="0" width="1000" height="1250" fill="url(#fadeG)"/></mask>
  <clipPath id="area"><rect x="40" y="40" width="920" height="950"/></clipPath>
</defs>
<rect width="1000" height="1250" fill="url(#paper)"/>
<g clip-path="url(#area)" mask="url(#fade)">
  <rect x="40" y="40" width="920" height="950" fill="url(#gMaj)" transform="translate(-5 -5)"/>
  <g transform="translate(50 65) scale(.9)" fill="none" stroke="${guideInk}" stroke-opacity=".62">
    <g stroke-width="1.05" vector-effect="non-scaling-stroke" style="vector-effect:non-scaling-stroke">${gc}${gl}</g>
    <g stroke-width="1.2" stroke-opacity=".9">${cr}</g>
  </g>
</g>
<g clip-path="url(#area)" transform="translate(50 65) scale(.9)">
  <g class="mass">${massPaths(data, ink, `fill-opacity=".2" stroke="${guideInk}" stroke-opacity=".75" stroke-width="1.3"`)}</g>
  <g class="dots" fill="${ink}" fill-opacity=".8">${dots}</g>
</g>
<rect x="40.5" y="40.5" width="919" height="1169" fill="none" stroke="#9B958A" stroke-opacity=".55"/>
<line x1="40" y1="990" x2="960" y2="990" stroke="#9B958A" stroke-opacity=".45"/>
<line x1="730" y1="990" x2="730" y2="1210" stroke="#9B958A" stroke-opacity=".45"/>
<text x="500" y="108" text-anchor="middle" font-family="'Cormorant Garamond','Shippori Mincho',serif" font-size="38" font-weight="600" fill="#3C3830" letter-spacing="1">${esc(title)}</text>
${phiNote}
<text x="95" y="1048" font-family="'Shippori Mincho',serif" font-size="17" fill="#5C574D" letter-spacing="5">コンセプト</text>
<g font-family="'Hiragino Sans','Noto Sans JP',sans-serif" font-size="19.5" fill="#6A655B">
  ${lines.map((t, i) => `<text x="95" y="${1092 + i * 33}">${esc(t)}</text>`).join('')}
</g>
<svg class="fin" x="752" y="1006" width="186" height="186" viewBox="${bb}">${massPaths(data, ink)}</svg>
</svg>`;
  }

  /** ロゴだけ。opts = { size, transparent } */
  function logoSVG(st, opts = {}) {
    const { data, ink, bbox } = st;
    const b = bbox || { x: 220, y: 220, width: 560, height: 560 };
    const sc = (opts.size || 400) / Math.max(b.width, b.height);
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
    const bg = opts.transparent ? '' : `<defs><linearGradient id="lp" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F3F2ED"/><stop offset=".55" stop-color="#ECEAE3"/><stop offset="1" stop-color="#C9C5BC"/></linearGradient></defs><rect width="1000" height="1000" fill="url(#lp)"/>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" role="img" aria-label="${esc(st.brand || data.title || 'ロゴ')}">${bg}<g transform="translate(500 500) scale(${r1(sc * 100) / 100}) translate(${r1(-cx)} ${r1(-cy)})">${massPaths(data, ink)}</g></svg>`;
  }

  /** 保存するときのファイル名 (使えない字は _ に) */
  function fileName(st, suffix) {
    return `${(st.brand || st.data.title || 'logo').replace(/[\\/:*?"<>|\s]+/g, '_')}${suffix}`;
  }

  /* ---------- 頼み方 ---------- */
  const PHI_INK = '#9A6B1F';
  const RATIO = {
    free: '',
    golden: `Proportion — golden ratio: base the whole construction on the golden ratio φ = 1.618. Choose a base radius u (about 60–110) and take EVERY construction circle radius from the series u·φ^n (n = −2 … 4), e.g. 38.2, 61.8, 100, 161.8, 261.8, 423.6 when u = 100. Where you can, make key distances (between circle centres, and from the mark's centre) members of the same series too. Write each radius with 1 decimal, as the exact series value.`
  };
  const FRAME = {
    auto: 'Choose the framing that suits the subject best (free-standing figure, or enclosed in a ring like a Japanese kamon).',
    ring: 'Enclose the figure in a bold circular ring like a Japanese kamon (family crest). Parts of the figure may overlap or break the ring, separated by clean gaps.',
    free: 'No enclosing frame: a free-standing figure. It may stand on a simple flat ground shape.'
  };
  const FORMAT = `Reply with ONLY this JSON object and nothing else:
{"title": "a short name for the mark in Japanese", "concept": "2–3 sentences in Japanese, 90–130 characters, describing the pose or form and the geometric idea, in the calm tone of a design studio's concept note", "circles": [{"cx": 500, "cy": 470, "r": 210}], "lines": [{"x1": 0, "y1": 900, "x2": 1000, "y2": 300}], "shapes": ["M ... Z", "M ... Z"]}`;
  const METHOD = `Canvas: 1000 × 1000 units, origin top-left, y pointing down. Keep the mark inside x 220–780, y 220–780, visually centred on (500, 500).

Method — follow it literally:
1. Decide the construction first: 8–18 circles and 6–14 straight lines that define every curve and every important angle of the mark (body, head, limbs, wings, eye, ground…). Circles may be large and extend past the box. Lines should express the main axes and diagonals of the pose.
2. Draw the mark ONLY with arcs that lie exactly on those circles, plus straight segments. Every "A" command must use rx = ry = the radius of one of your construction circles, x-axis-rotation 0, and both endpoints must lie on that circle.
3. Build bold, flat masses. Separate masses with clean gaps 8–14 units wide (negative-space cuts), like a knife-cut emblem. Use inner subpaths as holes for eyes, spirals and cut lines (the shapes are filled with fill-rule evenodd). No strokes, no gradients, nothing thinner than 10 units.
4. The silhouette must be instantly recognisable at 32 px. Prefer a few large confident shapes over fussy detail. Asymmetric dynamic poses are welcome.

Path syntax: absolute commands M, L, A, Z only. Separate every number with a space, write the two arc flags as separate 0/1 tokens, round to 1 decimal. Each closed outline ends with Z.`;

  /** current があれば「なおす」の頼み方になる */
  function buildPrompt(desc, frame, fix, current, ratio) {
    const prop = RATIO[ratio] ? `\n\n${RATIO[ratio]}` : '';
    if (fix && current) {
      const cur = JSON.stringify({ title: current.title, concept: current.concept, circles: current.circles, lines: current.lines, shapes: current.shapes });
      return `You are a logo designer who constructs marks with compass and straightedge, in the tradition of classic emblems and Japanese kamon.

The original brief was:
"""${desc}"""

Here is the current design:
${cur}

Revise the design according to this request from the client (keep everything else that works):
"""${fix}"""${prop}

${METHOD}

Update the concept text if the form changed.

${FORMAT}`;
    }
    return `You are a logo designer who constructs marks with compass and straightedge, in the tradition of classic emblems and Japanese kamon. Design a flat, single-colour logo mark for this brief:
"""${desc}"""

${FRAME[frame] || FRAME.auto}${prop}

${METHOD}

${FORMAT}`;
  }

  /** 返ってきたものを整える。形が無ければ投げる */
  function normalize(raw) {
    if (!raw || typeof raw !== 'object') throw { code: 'invalid_json' };
    const shapes = (Array.isArray(raw.shapes) ? raw.shapes : []).map((s) => typeof s === 'string' ? s : s && s.d).filter(Boolean).map(cleanD).filter((d) => /[Mm]/.test(d));
    if (!shapes.length) throw { code: 'empty_shapes' };
    return {
      title: String(raw.title || '').slice(0, 30),
      concept: String(raw.concept || '').slice(0, 200),
      circles: (Array.isArray(raw.circles) ? raw.circles : []).filter((c) => c && num(c.cx) && num(c.cy) && num(c.r)).slice(0, 40),
      lines: (Array.isArray(raw.lines) ? raw.lines : []).filter((l) => l && [l.x1, l.y1, l.x2, l.y2].every(num)).slice(0, 30),
      shapes
    };
  }

  /** 文章の中から JSON を取り出す (前後に余計な字やコードの囲いがあっても読む) */
  function extractJSON(text) {
    const s = String(text || '');
    try { return JSON.parse(s); } catch (e) { /* 下へ */ }
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { /* 下へ */ } }
    throw { code: 'invalid_json' };
  }

  /* ---------- Anthropic API (自分のキーで呼ぶとき) ---------- */
  const API_URL = 'https://api.anthropic.com/v1/messages';
  const MODEL = 'claude-opus-5-5';
  const EFFORT = { default: 'medium', complex: 'high' };

  const point = (keys) => ({ type: 'object', properties: Object.fromEntries(keys.map((k) => [k, { type: 'number' }])), required: keys, additionalProperties: false });
  /** 返事の形を API 側で縛る。JSON として必ず読める */
  const SCHEMA = {
    type: 'object',
    properties: {
      title: { type: 'string' },
      concept: { type: 'string' },
      circles: { type: 'array', items: point(['cx', 'cy', 'r']) },
      lines: { type: 'array', items: point(['x1', 'y1', 'x2', 'y2']) },
      shapes: { type: 'array', items: { type: 'string' } }
    },
    required: ['title', 'concept', 'circles', 'lines', 'shapes'],
    additionalProperties: false
  };

  function buildRequest(apiKey, prompt, tier) {
    return {
      url: API_URL,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        'anthropic-beta': 'server-side-fallback-2026-07-01'
      },
      body: {
        model: MODEL,
        max_tokens: 32000,
        stream: true,
        fallbacks: 'default',
        output_config: { effort: EFFORT[tier] || EFFORT.default, format: { type: 'json_schema', schema: SCHEMA } },
        messages: [{ role: 'user', content: prompt }]
      }
    };
  }

  /**
   * ストリーム (SSE) を読む。チャンクの切れ目がイベントの途中でもよい。
   * feed(文字列) を呼ぶたびに、まとまったぶんを反映する。
   */
  function createStreamReader() {
    let buf = '';
    const out = { text: '', stop: null, error: null, model: null };
    function handle(ev) {
      if (ev.type === 'message_start' && ev.message) out.model = ev.message.model;
      else if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') out.text += ev.delta.text;
      else if (ev.type === 'message_delta' && ev.delta && ev.delta.stop_reason) out.stop = ev.delta.stop_reason;
      else if (ev.type === 'error') out.error = ev.error || { type: 'unknown' };
    }
    function feed(chunk) {
      // \r と \n が別のチャンクに分かれて届くことがあるので、たまった全体で揃える
      buf = (buf + String(chunk)).replace(/\r\n/g, '\n');
      let at;
      while ((at = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, at); buf = buf.slice(at + 2);
        const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
        if (!data) continue;
        try { handle(JSON.parse(data)); } catch (e) { /* 壊れた 1 件は捨てる */ }
      }
      return out;
    }
    return { feed, result: out };
  }

  /** API の失敗を、画面で出し分ける code にする */
  function apiErrorCode(status, type) {
    if (status === 401 || type === 'authentication_error') return 'bad_key';
    if (status === 403 || type === 'permission_error') return 'forbidden';
    if (status === 429 || type === 'rate_limit_error') return 'rate_limited';
    if (status === 529 || type === 'overloaded_error') return 'overloaded';
    if (status === 413 || type === 'request_too_large') return 'prompt_too_large';
    if (status === 400 || type === 'invalid_request_error') return 'bad_request';
    return 'network';
  }

  return {
    INKS, PHI, goldenPairs, RATIO, esc, num, r1, cleanD, parsePath, arcCenter, pathBBox, buildGuides, circD, massPaths,
    wrapJa, padBox, sheetSVG, logoSVG, fileName, FRAME, buildPrompt, normalize, extractJSON,
    MODEL, SCHEMA, buildRequest, createStreamReader, apiErrorCode
  };
});
