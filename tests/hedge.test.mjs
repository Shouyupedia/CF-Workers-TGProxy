// Hedged upstream dial through the real Worker under Miniflare, against the mock KWS. Run: node --test tests/hedge.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { start, bootstrap, session, Lane, T } from './helpers/harness.mjs';

const enc = s => new TextEncoder().encode(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const open = async (h, token, sid, opts) => { const l = new Lane(h, token, sid); await l.open(); if (l.status === 101) await l.handshake(opts); return l; };
const echo = async (lane, text, ms) => { await lane.sendPacket(enc(text)); await lane.until(l => l.frames.some(f => f.type === T.DATA), ms); return new TextDecoder().decode((await lane.readPlain()).subarray(4)); };
async function withWorker(bindings, fn) { const h = await start(bindings); try { await fn(h); } finally { await h.dispose(); } }
// DC 2, non-media: primary kws2, backup kws2-1
const P = 'kws2.web.telegram.org', B = 'kws2-1.web.telegram.org';
const of = (log, host) => log.filter(k => k.host === host);

test('hedge: a fast primary is the only upstream ever contacted', () => withWorker({ DIAL_HEDGE_MS: '200' }, async h => {
  const s = await session(h, (await bootstrap(h)).boot);
  const lane = await open(h, s.token, 1, { dc: 2 });
  assert.equal(await echo(lane, 'fast'), 'fast');
  await sleep(400);
  const log = await h.kwsLog();
  assert.deepEqual(log.map(k => k.host), [P]);
}));

test('hedge: a slow primary is overtaken by the backup; the loser gets neither header nor data', () => withWorker({ DIAL_HEDGE_MS: '200' }, async h => {
  await h.kwsCtl({ [P]: { delay: 3000 } });
  const s = await session(h, (await bootstrap(h)).boot);
  const t0 = Date.now();
  const lane = await open(h, s.token, 1, { dc: 2 });
  assert.equal(await echo(lane, 'via-backup', 2500), 'via-backup');
  assert.ok(Date.now() - t0 < 2500, `took ${Date.now() - t0} ms`);
  assert.equal(await echo(lane, 'again'), 'again');
  await sleep(3500); // let the slow upgrade finish so a late arrival would show up
  const log = await h.kwsLog(), [win] = of(log, B), [lose] = of(log, P);
  assert.ok(win && lose);
  assert.ok(win.t - lose.t >= 150, 'backup only after the hedge delay');
  assert.equal(win.dc, 2); assert.ok(win.msgs >= 2);
  assert.equal(lose.tag, undefined); assert.equal(lose.msgs, 0); assert.equal(lose.bytes, 0);
}));

test('hedge: a primary that fails fast starts the backup without waiting for the hedge delay', () => withWorker({ DIAL_HEDGE_MS: '5000' }, async h => {
  await h.kwsCtl({ [P]: { status: 502 } });
  const s = await session(h, (await bootstrap(h)).boot);
  const t0 = Date.now();
  const lane = await open(h, s.token, 1, { dc: 2 });
  assert.equal(await echo(lane, 'fallback'), 'fallback');
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
  const log = await h.kwsLog();
  assert.deepEqual(log.map(k => k.host), [P, B]);
}));

test('hedge: DIAL_HEDGE_MS=7500 keeps the old serial behaviour (no backup while the primary is merely slow)', () => withWorker({ DIAL_HEDGE_MS: '7500' }, async h => {
  await h.kwsCtl({ [P]: { delay: 1500 } });
  const s = await session(h, (await bootstrap(h)).boot);
  const lane = await open(h, s.token, 1, { dc: 2 });
  assert.equal(await echo(lane, 'serial', 5000), 'serial');
  assert.deepEqual((await h.kwsLog()).map(k => k.host), [P]);
}));

test('hedge: a lane closed by the client mid-dial sends nothing upstream and other lanes keep working', () => withWorker({ DIAL_HEDGE_MS: '100' }, async h => {
  await h.kwsCtl({ [P]: { delay: 1500 }, [B]: { delay: 1500 } });
  const s = await session(h, (await bootstrap(h)).boot);
  const gone = await open(h, s.token, 1, { dc: 2 });
  await sleep(300); // both candidates are in flight now
  gone.close();
  await sleep(2500);
  const log = await h.kwsLog();
  assert.equal(log.length, 2);
  for (const k of log) { assert.equal(k.tag, undefined); assert.equal(k.msgs, 0); }
  const ok = await open(h, s.token, 2, { dc: 1 });
  assert.equal(await echo(ok, 'sibling'), 'sibling');
}));

test('hedge: both candidates failing closes only that stream', () => withWorker({ DIAL_HEDGE_MS: '100' }, async h => {
  await h.kwsCtl({ [P]: { status: 502 }, [B]: { delay: 200, status: 503 } });
  const s = await session(h, (await bootstrap(h)).boot);
  const bad = await open(h, s.token, 1, { dc: 2 });
  await bad.until(l => l.closed);
  assert.ok(bad.frames.some(f => f.type === T.CLOSE));
  const ok = await open(h, s.token, 2, { dc: 3 });
  assert.equal(await echo(ok, 'dc3'), 'dc3');
}));
