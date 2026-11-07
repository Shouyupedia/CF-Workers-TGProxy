// Pure-function tests. Run: node --test tests/unit.test.mjs  (Node >= 20, no dependencies)
import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers/load.mjs';
import { CtrStream, pktEE, rand } from './helpers/obfs.mjs';

const W = await load(['CFG', 'mkCap', 'bridge', 'mkToken', 'unseal', 'verify', 'mkSess', 'sessOf', 'authBoot', 'mkCtr', 'enc', 'frames', 'mkPkt', 'mkHead', 'headOf', 'mkWire', 'mkStream', 'mkSession', 'mkCfg', 'allow', 'small', 'buckets', 'dnBuf', 'b64', 'cat', 'macKeys']);
const SECRET = '000102030405060708090a0b0c0d0e0f', HOST = 'proxy.example.com';
const BRIDGE = 'MHLEY5PmW1GWqJkSrlmJpvJUiLhBH_QKy6yKg8a0JPk'; // tproxy-server PROTOCOL.md test vector
const now = () => Math.floor(Date.now() / 1000);
const cfg = (env = {}) => W.mkCfg({ SECRET, BOOT: 'unit-boot-key', ...env });

test('bridge capability matches the official test vector, also with several SECRETs', async () => {
  assert.equal(await W.mkCap(SECRET, HOST), BRIDGE);
  const url = new URL(`https://${HOST}/?bridge=${BRIDGE}`);
  assert.equal(await W.bridge(url, [SECRET]), HOST);
  assert.equal(await W.bridge(url, ['ffeeddccbbaa99887766554433221100', SECRET]), HOST);
  assert.equal(await W.bridge(url, ['ffeeddccbbaa99887766554433221100']), null);
  assert.equal(await W.bridge(new URL(`https://other.example.com/?bridge=${BRIDGE}`), [SECRET]), null);
  assert.equal(await W.bridge(new URL(`https://${HOST}/?bridge=${BRIDGE}&x=1`), [SECRET]), null);
});

test('mkCfg: secret list, limits, clamped lifetimes', () => {
  const c = cfg({ SECRET: `${SECRET}, dd${'ab'.repeat(16)}`, SESSION_TTL: '5', SESSION_MAX: '999999999' });
  assert.equal(c.keys.length, 2);
  assert.equal(c.ttl, 10);
  assert.equal(c.max, 7 * 86400);
  assert.equal(cfg().ttl, W.CFG.sessTtl);
  assert.equal(cfg().max, W.CFG.sessMax);
  assert.throws(() => cfg({ SECRET: 'nothex' }));
  assert.throws(() => cfg({ SECRET: Array(5).fill(SECRET).join(',') }));
  assert.throws(() => W.mkCfg({ SECRET }));
});

test('raw BOOT is no longer accepted as a bootstrap bearer', async () => {
  assert.equal(await W.authBoot('unit-boot-key', 'unit-boot-key'), false);
});

test('session tokens: round trip, renewal keeps identity, tamper/kind/expiry/lifetime checks', async () => {
  const c = cfg();
  const born = now(), id = rand(8);
  const a = await W.mkSess(c, born, id);
  assert.match(a.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(a.ttl, c.ttl);
  const s = await W.sessOf(a.token, c);
  assert.equal(s.born, born);
  assert.equal(s.id, W.b64(id));
  const b = await W.mkSess(c, s.born, s.raw); // renewal
  assert.equal((await W.sessOf(b.token, c)).id, s.id);
  // tamper
  const bad = (a.token[5] === 'A' ? 'B' : 'A');
  assert.equal(await W.sessOf(a.token.slice(0, 5) + bad + a.token.slice(6), c), null);
  // kind separation: a bootstrap token is not a session token and vice versa
  const boot = await W.mkToken(c.boot, 'bootstrap', now() + 60, rand(12));
  assert.equal(await W.sessOf(boot, c), null);
  assert.equal(await W.verify(a.token, c.boot, 'bootstrap'), false);
  // expired token: rejected for lanes, accepted within the renewal grace
  const tail = new Uint8Array(12); new DataView(tail.buffer).setUint32(0, born, false); tail.set(id, 4);
  const old = await W.mkToken(c.boot, 'session.v2', now() - 5, tail);
  assert.equal(await W.sessOf(old, c), null);
  assert.ok(await W.sessOf(old, c, W.CFG.sessGrace));
  // past the absolute lifetime nothing is accepted and nothing can be renewed
  const ancient = now() - c.max - 1;
  const t2 = new Uint8Array(12); new DataView(t2.buffer).setUint32(0, ancient, false);
  assert.equal(await W.sessOf(await W.mkToken(c.boot, 'session.v2', now() + 60, t2), c, W.CFG.sessGrace), null);
  assert.equal(await W.mkSess(c, now() - c.max + 5, id), null);
  const near = await W.mkSess(c, now() - c.max + 100, id);
  assert.ok(near.ttl <= 100);
});

test('mkCtr: arbitrary chunking gives the one-shot keystream; overlapping calls fail instead of reusing keystream', async () => {
  for (let t = 0; t < 50; t++) {
    const key = rand(32), iv = rand(16), data = rand(1 + Math.floor(Math.random() * 4000));
    const ref = await new CtrStream(key, iv).xor(data);
    const c = W.mkCtr(key, iv), parts = [];
    for (let o = 0; o < data.length;) { const n = Math.min(data.length - o, 1 + Math.floor(Math.random() * 70)); parts.push(await c.crypt(data.subarray(o, o + n))); o += n; }
    assert.deepEqual(new Uint8Array(Buffer.concat(parts.map(p => Buffer.from(p)))), ref);
  }
  const c = W.mkCtr(rand(32), rand(16));
  const [a, b] = await Promise.allSettled([c.crypt(rand(20)), c.crypt(rand(20))]);
  assert.equal(a.status, 'fulfilled'); assert.equal(b.status, 'rejected');
});

test('frames: encode/decode and malformed input', () => {
  const f = W.enc(2, 7, new Uint8Array([1, 2, 3]));
  const [x] = W.frames(f);
  assert.equal(x.type, 2); assert.equal(x.sid, 7); assert.deepEqual([...x.payload], [1, 2, 3]);
  assert.throws(() => W.frames(f.subarray(0, 9)));
  const big = new Uint8Array(8); big[0] = 2; new DataView(big.buffer).setUint32(4, 1024 * 1024 + 1); assert.throws(() => W.frames(big));
  const bad = W.enc(2, 1, new Uint8Array([1])); bad[0] = 9; assert.throws(() => W.frames(bad));
  assert.throws(() => W.frames(new Uint8Array(Array(4097).fill([...W.enc(1, 1)]).flat())));
});

test('mkPkt: packet boundaries for 0xef / 0xee / 0xdd across arbitrary splits', () => {
  for (const mode of [0xef, 0xee, 0xdd]) {
    const sizes = [4, 8, 400, 2000, 4];
    const wire = sizes.map(n => {
      const p = rand(n);
      if (mode !== 0xef) return pktEE(p);
      const w = n / 4; return w < 0x7f ? Uint8Array.of(w, ...p) : Uint8Array.of(0x7f, w & 255, (w >> 8) & 255, w >> 16, ...p);
    });
    const all = Buffer.concat(wire.map(w => Buffer.from(w)));
    const pk = W.mkPkt(mode), out = [];
    for (let o = 0; o < all.length;) { const n = Math.min(all.length - o, 1 + Math.floor(Math.random() * 300)); out.push(...pk.push(all.subarray(o, o + n))); o += n; }
    assert.deepEqual(out.map(p => p.byteLength), wire.map(w => w.length));
  }
  assert.throws(() => W.mkPkt(0xee).push(new Uint8Array(4)));
});

test('mkHead: never emits a reserved first word, round-trips through headOf', () => {
  const bad = new Set([0x44414548, 0x54534f50, 0x20544547, 0x4954504f, 0xeeeeeeee, 0xdddddddd, 0x02010316]);
  for (let i = 0; i < 20000; i++) {
    const h = W.mkHead(0xee, i % 5, i % 2 === 0), v = new DataView(h.buffer);
    assert.notEqual(h[0], 0xef); assert.ok(!bad.has(v.getUint32(0, true))); assert.notEqual(v.getUint32(4, true), 0);
    if (i < 50) assert.deepEqual(W.headOf(h), { mode: 0xee, target: i % 5, media: i % 2 === 0 });
  }
});

class FakeWS extends EventTarget { send() {} close() {} msg(n) { const e = new Event('message'); e.data = new ArrayBuffer(n); this.dispatchEvent(e); } }

test('mkWire: per-lane cap closes only that upstream and releases its buffer', async () => {
  const ws = new FakeWS(); let overflow = 0;
  const wire = W.mkWire(ws, null, () => overflow++);
  assert.equal(await (ws.msg(1000), wire.readPack()).then(b => b.byteLength), 1000);
  for (let i = 0; i < 40 && !wire.closed; i++) ws.msg(1024 * 1024);
  assert.equal(overflow, 1); assert.ok(wire.closed);
  assert.equal(W.dnBuf, 0);
  wire.close(); assert.equal(W.dnBuf, 0);
});

test('mkWire: isolate-wide cap across lanes, accounting returns to zero', async () => {
  const wires = [], ws = [], hit = [];
  for (let i = 0; i < 4; i++) { ws.push(new FakeWS()); wires.push(W.mkWire(ws[i], null, () => hit.push(i))); }
  for (let i = 0; i < 4; i++) for (let k = 0; k < 13; k++) ws[i].msg(1024 * 1024); // 4 x 13 MiB > 48 MiB
  assert.deepEqual(hit, [3]);
  assert.ok(W.dnBuf > 36 * 1024 * 1024);
  // draining one lane frees budget
  let n = 0; while (n < 13 * 1024 * 1024) n += (await wires[0].readPack()).byteLength;
  assert.ok(W.dnBuf < 27 * 1024 * 1024);
  for (const w of wires) w.close();
  assert.equal(W.dnBuf, 0);
});

test('allow(): per-isolate fallback window per IP and kind', async () => {
  W.buckets.clear();
  const req = ip => new Request('https://x.example/', { headers: { 'CF-Connecting-IP': ip } });
  for (let i = 0; i < W.CFG.rlSess; i++) assert.equal(await W.allow({}, 'sess', req('1.1.1.1')), true);
  assert.equal(await W.allow({}, 'sess', req('1.1.1.1')), false);
  assert.equal(await W.allow({}, 'sess', req('2.2.2.2')), true);
  assert.equal(await W.allow({}, 'lane', req('1.1.1.1')), true);
  assert.equal(await W.allow({ RL_SESSION: { limit: async () => ({ success: false }) } }, 'sess', req('3.3.3.3')), false);
  assert.equal(await W.allow({ RL_SESSION: { limit: async () => { throw Error(); } } }, 'sess', req('3.3.3.3')), true);
});

test('small(): body size cap with and without Content-Length', async () => {
  const mk = (body, headers = {}) => new Request('https://x.example/', { method: 'POST', body, headers });
  assert.deepEqual([...await W.small(mk(new Uint8Array(9)), 64)], Array(9).fill(0));
  assert.equal(await W.small(mk(new Uint8Array(65)), 64), null);
  const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(40)); c.enqueue(new Uint8Array(40)); c.close(); } });
  assert.equal(await W.small(new Request('https://x.example/', { method: 'POST', body: stream, duplex: 'half' }), 64), null);
});

test('mkStream: a failed push closes the stream itself (onClose fires) and the queued push rejects without writing', async () => {
  const origFetch = globalThis.fetch;
  const fakeWs = new FakeWS(); fakeWs.accept = () => {};
  const sent = []; fakeWs.send = b => sent.push(new Uint8Array(b));
  globalThis.fetch = async () => ({ status: 101, webSocket: fakeWs, headers: new Headers({ 'Sec-WebSocket-Protocol': 'binary' }) });
  try {
    const c = cfg();
    const { clientHandshake, pktEE } = await import('./helpers/obfs.mjs');
    const obf = await clientHandshake(SECRET, { dc: 2 });
    let closedCount = 0;
    const s = W.mkStream({ keys: c.keys, emit: async () => {}, onClose: () => { closedCount++; } });
    await s.push(obf.wire); // handshake succeeds
    const before = sent.length;
    // Queue two pushes > upPack apart so they don't coalesce: first has a 0-length packet (throws in mkPkt), second is valid
    const badPkt = await obf.tx.xor(new Uint8Array(4)); // pLen = 0 -> mkPkt throws!
    const validPad = await obf.tx.xor(pktEE(new Uint8Array(20 * 1024)));
    const [r1, r2] = await Promise.allSettled([s.push(badPkt), s.push(validPad)]);
    assert.equal(r1.status, 'rejected');
    assert.equal(r2.status, 'rejected');
    assert.equal(sent.length, before, 'no packets written after stream error');
    assert.equal(closedCount, 1, 'stream released its upstream on its own');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('small(): Content-Length must be plain decimal digits (RFC 9110 1*DIGIT)', async () => {
  const mk = (len) => new Request('https://x.example/', { method: 'POST', body: new Uint8Array(4), headers: { 'Content-Length': len } });
  assert.equal((await W.small(mk('4'), 64))?.byteLength, 4);
  for (const len of ['-5', '1.5', 'abc', '', '0x10', '1e1', '+4']) assert.equal(await W.small(mk(len), 64), null, `Content-Length ${JSON.stringify(len)}`);
});

test('b64: encodes buffers past the spread-argument limit (1 MiB) without RangeError', () => {
  // 1048576 = 3 * 349525 + 1 -> 349525 * 4 + 2 unpadded chars; zero bytes encode as 'A'
  assert.equal(W.b64(new Uint8Array(1048576)), 'A'.repeat(1398102));
});

test('cat: zero-copy or single-part fast path and multi-part concatenation', () => {
  const a = new Uint8Array([1, 2, 3]), b = new Uint8Array([4, 5]);
  assert.equal(W.cat().byteLength, 0);
  assert.strictEqual(W.cat(a), a); // single Uint8Array should return as-is without reallocating
  assert.strictEqual(W.cat(null, new Uint8Array(0), a), a);
  assert.deepEqual([...W.cat(a, b)], [1, 2, 3, 4, 5]);
});

test('mkCfg: caches parsed config across calls with identical env values', () => {
  const env1 = { SECRET: `${SECRET}, dd${'ab'.repeat(16)}`, BOOT: 'boot-1', SESSION_TTL: '120', SESSION_MAX: '3600', LANE_LOG: '1' };
  const env2 = { SECRET: `${SECRET}, dd${'ab'.repeat(16)}`, BOOT: 'boot-1', SESSION_TTL: '120', SESSION_MAX: '3600', LANE_LOG: '1' };
  const c1 = W.mkCfg(env1), c2 = W.mkCfg(env2);
  assert.strictEqual(c1, c2);
  const c3 = W.mkCfg({ ...env1, SESSION_TTL: '180' });
  assert.notStrictEqual(c1, c3);
  assert.equal(c3.ttl, 180);
});

test('mkCfg: a rejected config keeps being rejected instead of returning the previously cached one', () => {
  const good = W.mkCfg({ SECRET, BOOT: 'old-boot' });
  assert.equal(good.boot, 'old-boot');
  const bad = { SECRET: 'invalid', BOOT: 'new-boot' };
  assert.throws(() => W.mkCfg(bad));
  assert.throws(() => W.mkCfg(bad));
});

test('mkCfg: field boundaries are part of the cache key (newlines inside values do not collide)', () => {
  const k1 = 'ab'.repeat(16), k2 = 'cd'.repeat(16);
  const a = W.mkCfg({ SECRET: `${k1}\n${k2}`, BOOT: 'x' });
  const b = W.mkCfg({ SECRET: k1, BOOT: `${k2}\nx` });
  assert.equal(a.keys.length, 2);
  assert.equal(b.keys.length, 1);
  assert.equal(b.boot, `${k2}\nx`);
});

test('macKey: cache is bounded so rotating secrets never leaks unbounded memory', async () => {
  for (let i = 0; i < 40; i++) {
    await W.mkToken(`boot-rotate-${i}`, 'bootstrap', now() + 60, rand(12));
  }
  assert.ok(W.macKeys.size <= 32, `macKeys.size=${W.macKeys.size} should be bounded`);
});
