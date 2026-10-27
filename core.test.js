const test = require('node:test');
const assert = require('node:assert');
const Core = require('./core.js');
const FIX = require('./fixture.js');

const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;

test('パスを読む: 頂点・弧・線分', () => {
  const p = Core.parsePath('M 10 20 L 110 20 A 50 50 0 0 1 160 70 Z');
  assert.deepStrictEqual(p.verts, [[10, 20], [110, 20], [160, 70]]);
  assert.strictEqual(p.arcs.length, 1);
  assert.strictEqual(p.segs.length, 2, '直線と、閉じる辺');
});

test('相対コマンドも絶対位置になる', () => {
  const p = Core.parsePath('m 100 100 l 50 0 v 40 h -50 z');
  assert.deepStrictEqual(p.verts, [[100, 100], [150, 100], [150, 140], [100, 140]]);
});

test('弧の中心: 両端が円の上にのる (中心をずらしても、4 通りの旗でも)', () => {
  const cx = 537.3, cy = 412.9, r = 130;
  const at = (t) => [cx + r * Math.cos(t), cy + r * Math.sin(t)];
  for (const [t1, t2] of [[0.3, 1.9], [2.2, 5.1], [4.0, 0.5]]) {
    const [x1, y1] = at(t1), [x2, y2] = at(t2);
    for (const fa of [0, 1]) for (const fs of [0, 1]) {
      const c = Core.arcCenter({ x1, y1, x2, y2, r, fa, fs });
      assert.ok(near(Math.hypot(x1 - c.cx, y1 - c.cy), r) && near(Math.hypot(x2 - c.cx, y2 - c.cy), r), '両端が半径 r');
    }
    // 4 通りのうち、元の中心と一致するものがある
    const hits = [0, 1].flatMap((fa) => [0, 1].map((fs) => Core.arcCenter({ x1, y1, x2, y2, r, fa, fs })))
      .filter((c) => near(c.cx, cx, 0.05) && near(c.cy, cy, 0.05));
    assert.ok(hits.length >= 1, '元の中心が出る');
  }
});

test('外接矩形: 弧のふくらみまで入る (ずらした円)', () => {
  const b = Core.pathBBox([FIX.shapes[0]]);
  assert.ok(near(b.x, 290) && near(b.y, 230) && near(b.width, 480) && near(b.height, 480), JSON.stringify(b));
});

test('外接矩形: 半円は、ふくらんだ側だけ広がる', () => {
  // (100,300) → (300,300) を時計回り (fs=1, y 下向き) で上へふくらむ半円
  const up = Core.pathBBox(['M 100 300 A 100 100 0 0 1 300 300 Z']);
  assert.ok(near(up.y, 200) && near(up.height, 100), '上へ: ' + JSON.stringify(up));
  const down = Core.pathBBox(['M 100 300 A 100 100 0 0 0 300 300 Z']);
  assert.ok(near(down.y, 300) && near(down.height, 100), '下へ: ' + JSON.stringify(down));
});

test('補助線: 弧から円を逆算し、重なりは 1 本にまとめる', () => {
  const g = Core.buildGuides(FIX);
  // 宣言 3 円 + 弧から出る円はどれも宣言と同じなので増えない
  assert.strictEqual(g.circles.length, 3, JSON.stringify(g.circles));
  assert.ok(g.lines.length >= 2);
  assert.ok(g.verts.length > 0);
});

test('normalize: 形が無ければ投げ、変な字は捨てる', () => {
  assert.throws(() => Core.normalize({ title: 'x', shapes: [] }), (e) => e.code === 'empty_shapes');
  assert.throws(() => Core.normalize(null), (e) => e.code === 'invalid_json');
  const d = Core.normalize({ title: 'x', shapes: ['M 0 0 L 10 0 <script> Z'], circles: [{ cx: 1, cy: 2, r: 'a' }] });
  assert.ok(!/script/.test(d.shapes[0]));
  assert.strictEqual(d.circles.length, 0, '数でない円は捨てる');
});

test('extractJSON: 前後に字やコードの囲いがあっても読む', () => {
  assert.deepStrictEqual(Core.extractJSON('{"a":1}'), { a: 1 });
  assert.deepStrictEqual(Core.extractJSON('はい\n```json\n{"a":2}\n```'), { a: 2 });
  assert.throws(() => Core.extractJSON('だめ'), (e) => e.code === 'invalid_json');
});

test('ストリーム: チャンクの切れ目がイベントの途中でも、文字が欠けない', () => {
  const evs = [
    { type: 'message_start', message: { model: 'claude-opus-5-5' } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '{"title":"紋' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '"}' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' }
  ];
  const all = evs.map((e) => `event: ${e.type}\r\ndata: ${JSON.stringify(e)}\r\n\r\n`).join('');
  for (const size of [1, 3, 7, 50, all.length]) {
    const sr = Core.createStreamReader();
    for (let i = 0; i < all.length; i += size) sr.feed(all.slice(i, i + size));
    assert.strictEqual(sr.result.text, '{"title":"紋"}', `幅 ${size}`);
    assert.strictEqual(sr.result.stop, 'end_turn');
    assert.strictEqual(sr.result.model, 'claude-opus-5-5');
  }
});

test('ストリーム: 途中のエラーを拾う', () => {
  const sr = Core.createStreamReader();
  sr.feed('event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"x"}}\n\n');
  assert.strictEqual(Core.apiErrorCode(0, sr.result.error.type), 'overloaded');
});

test('API の頼み方: ブラウザ直の印・型の縛り・キー', () => {
  const r = Core.buildRequest('sk-test', 'hello', 'complex');
  assert.strictEqual(r.headers['x-api-key'], 'sk-test');
  assert.strictEqual(r.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.strictEqual(r.body.model, 'claude-opus-5-5');
  assert.strictEqual(r.body.stream, true);
  assert.strictEqual(r.body.output_config.effort, 'high');
  assert.strictEqual(Core.buildRequest('k', 'p', 'default').body.output_config.effort, 'medium');
  assert.strictEqual(r.body.output_config.format.type, 'json_schema');
  // 構造化出力は、どの階層の object にも additionalProperties:false が要る
  const walk = (s) => {
    if (s.type === 'object') { assert.strictEqual(s.additionalProperties, false); assert.deepStrictEqual(s.required.slice().sort(), Object.keys(s.properties).sort()); Object.values(s.properties).forEach(walk); }
    if (s.type === 'array') walk(s.items);
  };
  walk(r.body.output_config.format.schema);
});

test('頼み方: なおすときは今の形と注文が入る', () => {
  const p = Core.buildPrompt('獅子', 'ring', 'たてがみを大きく', FIX);
  assert.ok(p.includes('たてがみを大きく') && p.includes(FIX.shapes[1]) && p.includes('獅子'));
  const q = Core.buildPrompt('獅子', 'ring', null, null);
  assert.ok(q.includes(Core.FRAME.ring) && !q.includes('current design'));
});

test('設計図とロゴ: 名前は字をにがし、形がすべて入る', () => {
  const st = { data: FIX, guides: Core.buildGuides(FIX), bbox: Core.pathBBox(FIX.shapes), ink: '#22385A', brand: 'A&B <紋>' };
  const sheet = Core.sheetSVG(st, true);
  assert.ok(sheet.includes('A&amp;B &lt;紋&gt;') && !sheet.includes('<紋>'));
  assert.strictEqual((sheet.match(/class="gd"/g) || []).length, st.guides.circles.length + st.guides.lines.length);
  const logo = Core.logoSVG(st, { transparent: true, size: 820 });
  assert.strictEqual((logo.match(/<path /g) || []).length, FIX.shapes.length);
  assert.ok(!logo.includes('<rect'), '透明のときは背景なし');
  assert.strictEqual(Core.fileName(st, '.svg'), 'A&B_紋_.svg', '空白と < はまとめて 1 つの _');
});

test('ロゴは外接矩形の真ん中に据わる', () => {
  const st = { data: FIX, ink: '#000', bbox: Core.pathBBox(FIX.shapes), brand: '' };
  const m = Core.logoSVG(st, { size: 400 }).match(/translate\(500 500\) scale\(([\d.]+)\) translate\((-?[\d.]+) (-?[\d.]+)\)/);
  assert.ok(m, '置き方が読める');
  assert.ok(near(+m[2], -530) && near(+m[3], -470), `中心 ${m[2]},${m[3]}`);
  assert.ok(near(+m[1], 400 / 480, 0.01));
});

test('wrapJa: 行数を越えたら … で切る', () => {
  assert.deepStrictEqual(Core.wrapJa('あいうえおかきくけこ', 3, 2), ['あいう', 'えお…']);
  assert.deepStrictEqual(Core.wrapJa('', 3, 2), []);
});
