// Worker + mock KWS under Miniflare. Run: npm i && node --test tests/integration.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { start, bootstrap, session, Lane, T, u32, SECRET, BOOT, HOST } from './helpers/harness.mjs';
import { hello } from './helpers/frames.mjs';
import { load } from './helpers/load.mjs';

const W = await load(['mkCap']);
const enc = s => new TextEncoder().encode(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const open = async (h, token, sid, opts) => { const l = new Lane(h, token, sid); await l.open(); if (l.status === 101) await l.handshake(opts); return l; };
const echo = async (lane, text) => { await lane.sendPacket(enc(text)); await lane.until(l => l.frames.some(f => f.type === T.DATA)); return new TextDecoder().decode((await lane.readPlain()).subarray(4)); };
async function withWorker(bindings, fn, extra) { const h = await start(bindings, extra); try { await fn(h); } finally { await h.dispose(); } }

test('relay round trip; upstream handshake offers no WebSocket compression', () => withWorker({}, async h => {
  const s = await session(h, (await bootstrap(h)).boot);
  assert.equal(s.status, 200); assert.equal(s.ttl, '300');
  const lane = await open(h, s.token, 1, { dc: 4, media: true });
  assert.equal(await echo(lane, 'ping-1'), 'ping-1');
  const [k] = await h.kwsLog();
  assert.equal(k.host, 'kws4-1.web.telegram.org'); assert.equal(k.proto, 'binary'); assert.equal(k.ext, null); assert.equal(k.dc, -4);
}));

test('S-02: a lane that stops granting credit is closed at the buffer cap; sibling lanes keep working', () => withWorker({}, async h => {
  const s = await session(h, (await bootstrap(h)).boot);
  const slow = await open(h, s.token, 1), ok = await open(h, s.token, 2);
  await slow.sendPacket(enc('BLAST:600')); // 600 x 64 KiB = 37.5 MiB, never granted
  await slow.until(l => l.closed, 15000);
  assert.ok(slow.frames.some(f => f.type === T.CLOSE), 'CLOSE frame for the overflowing stream');
  assert.ok(slow.down <= 4 * 1024 * 1024);
  assert.equal(await echo(ok, 'still-alive'), 'still-alive');
}));

test('N-1: session renewal keeps identity, extends admission, and old tokens keep working until they expire', () => withWorker({ SESSION_TTL: '10' }, async h => {
  const s = await session(h, (await bootstrap(h)).boot);
  assert.equal(s.ttl, '10');
  const lane1 = await open(h, s.token, 1);
  await sleep(1100);
  const put = await h.fetch('/api/v1/session', { method: 'PUT', headers: { Authorization: `Bearer ${s.token}` } });
  assert.equal(put.status, 204);
  const t2 = put.headers.get('X-Session-Token'); assert.notEqual(t2, s.token); assert.equal(put.headers.get('X-Session-Ttl'), '10');
  await sleep(10500); // first token expired
  const late = new Lane(h, s.token, 2); await late.open(); assert.equal(late.status, 404);
  const put2 = await h.fetch('/api/v1/session', { method: 'PUT', headers: { Authorization: `Bearer ${t2}` } }); // within grace
  assert.equal(put2.status, 204);
  const lane3 = await open(h, put2.headers.get('X-Session-Token'), 3);
  assert.equal(await echo(lane3, 'renewed'), 'renewed');
  assert.equal(await echo(lane1, 'old-lane'), 'old-lane'); // established lanes are not tied to token expiry
}));

test('S-01/S-03: DELETE closes this isolate\'s lanes and blocks new lanes and renewal', () => withWorker({}, async h => {
  const s = await session(h, (await bootstrap(h)).boot);
  const a = await open(h, s.token, 1), b = await open(h, s.token, 2);
  await echo(a, 'x');
  const del = await h.fetch('/api/v1/session', { method: 'DELETE', headers: { Authorization: `Bearer ${s.token}` } });
  assert.equal(del.status, 204);
  await a.until(l => l.closed, 8000); await b.until(l => l.closed, 8000); // idle lanes notice within CFG.checkMs
  assert.ok(a.frames.some(f => f.type === T.CLOSE));
  const c = new Lane(h, s.token, 3); await c.open(); assert.equal(c.status, 409);
  const put = await h.fetch('/api/v1/session', { method: 'PUT', headers: { Authorization: `Bearer ${s.token}` } });
  assert.equal(put.status, 404);
}));

test('S-03: lanes end at the absolute session lifetime (SESSION_MAX)', { timeout: 90000 }, () => withWorker({ SESSION_MAX: '60', SESSION_TTL: '300' }, async h => {
  const s = await session(h, (await bootstrap(h)).boot);
  assert.ok(Number(s.ttl) <= 60);
  const lane = await open(h, s.token, 1);
  await echo(lane, 'x');
  await lane.until(l => l.closed, 70000);
  assert.ok(lane.frames.some(f => f.type === T.CLOSE));
}));

test('N-2: thousands of revoked sessions do not exhaust the lease table', { timeout: 120000 }, () => withWorker({}, async h => {
  const { boot } = await bootstrap(h);
  for (let batch = 0; batch < 170; batch++) { // 170 x 25 = 4250 distinct sessions (> 4096), 25 per source IP to stay under the limiter
    const ip = `10.${batch >> 8}.${batch & 255}.1`;
    const tokens = await Promise.all(Array.from({ length: 25 }, async () => (await session(h, boot, { 'CF-Connecting-IP': ip })).token));
    await Promise.all(tokens.map(t => h.fetch('/api/v1/session', { method: 'DELETE', headers: { Authorization: `Bearer ${t}` } })));
  }
  const s = await session(h, boot, { 'CF-Connecting-IP': '10.250.0.1' });
  const lane = await open(h, s.token, 1);
  assert.equal(lane.status, 101);
  assert.equal(await echo(lane, 'after-flood'), 'after-flood');
}));

test('S-05: per-IP fallback limiter and the optional RL_LANE binding', () => withWorker({}, async h => {
  const { boot } = await bootstrap(h);
  const codes = [];
  for (let i = 0; i < 31; i++) codes.push((await session(h, boot, { 'CF-Connecting-IP': '10.2.0.1' })).status);
  assert.equal(codes.filter(c => c === 200).length, 30);
  assert.equal(codes.at(-1), 429);
  assert.equal((await session(h, boot, { 'CF-Connecting-IP': '10.2.0.2' })).status, 200);
}).then(() => withWorker({}, async h => {
  const s = await session(h, (await bootstrap(h)).boot);
  const codes = [];
  for (let sid = 1; sid <= 3; sid++) { const l = new Lane(h, s.token, sid); await l.open(); codes.push(l.status); l.close(); }
  assert.deepEqual(codes, [101, 101, 429]);
}, { ratelimits: { RL_LANE: { namespace_id: '1001', simple: { limit: 2, period: 60 } } } })));

test('N-4 / input limits: raw BOOT rejected, oversized body rejected, bad grant closes the lane', () => withWorker({}, async h => {
  assert.equal((await session(h, BOOT)).status, 404);
  const { boot } = await bootstrap(h);
  const big = new Uint8Array(65); big.set(hello());
  const res = await h.fetch('/api/v1/session', { method: 'POST', body: big, headers: { Authorization: `Bearer ${boot}`, 'Content-Type': 'application/octet-stream' } });
  assert.equal(res.status, 404);
  const s = await session(h, boot);
  const lane = await open(h, s.token, 1);
  lane.grant(9 * 1024 * 1024); // > 2 x 4 MiB credit
  await lane.until(l => l.closed);
  assert.equal(lane.closeCode, 1008);
}));

test('S-04: two SECRETs active during rotation; a client on either works, a wrong one gets CLOSE', () => {
  const NEW = 'ffeeddccbbaa99887766554433221100';
  return withWorker({ SECRET: `${NEW},${SECRET}` }, async h => {
    const pNew = await bootstrap(h, await W.mkCap(NEW, HOST)), pOld = await bootstrap(h);
    assert.ok(pNew.boot && pOld.boot);
    const s = await session(h, pOld.boot);
    const a = await open(h, s.token, 1, { secret: NEW }), b = await open(h, s.token, 2, { secret: SECRET });
    assert.equal(await echo(a, 'new-secret'), 'new-secret');
    assert.equal(await echo(b, 'old-secret'), 'old-secret');
    const c = await open(h, s.token, 3, { secret: '0123456789abcdef0123456789abcdef' });
    await c.until(l => l.closed);
    assert.ok(c.frames.some(f => f.type === T.CLOSE));
    assert.equal((await bootstrap(h, await W.mkCap('0123456789abcdef0123456789abcdef', HOST))).boot, null);
  });
});

test('unreachable DC: dial failure closes only that stream', () => withWorker({}, async h => {
  const s = await session(h, (await bootstrap(h)).boot);
  const bad = await open(h, s.token, 1, { dc: 5 }), good = await open(h, s.token, 2, { dc: 1 });
  await bad.until(l => l.closed);
  assert.ok(bad.frames.some(f => f.type === T.CLOSE));
  assert.equal(await echo(good, 'dc1'), 'dc1');
  assert.deepEqual((await h.kwsLog()).filter(k => k.host.startsWith('kws5')).map(k => k.host).sort(), ['kws5-1.web.telegram.org', 'kws5.web.telegram.org']);
}));
