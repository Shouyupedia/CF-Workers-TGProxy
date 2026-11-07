// dial(): delayed backup ("hedged") upstream connect. Fake network only, no sockets. Run: node --test tests/dial.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers/load.mjs';

const W = await load(['dial', 'mkCfg', 'CFG', 'dnBuf']);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (pred, ms = 2000) => { const end = Date.now() + ms; while (!pred()) { if (Date.now() > end) throw Error('until: timeout'); await sleep(2); } };

class FakeUp extends EventTarget {
  constructor() { super(); this.sent = []; this.accepted = false; this.closedWith = null; }
  accept() { this.accepted = true; }
  send(b) { if (this.closedWith !== null) throw Error('send after close'); this.sent.push(b); }
  close(code) { this.closedWith = code ?? 1000; }
}
// every fetch() is a pending call the test settles by hand; abort rejects it unless the test asked for a "late" success
function fakeNet() {
  const calls = [];
  const fetch = (url, init) => new Promise((resolve, reject) => {
    const c = { host: new URL(url).hostname, init, ws: new FakeUp(), aborted: false, ignoreAbort: false, settled: false };
    c.ok = () => { if (c.settled) return; c.settled = true; resolve({ status: 101, webSocket: c.ws, headers: new Headers({ 'Sec-WebSocket-Protocol': 'binary' }) }); };
    c.fail = () => { if (c.settled) return; c.settled = true; reject(Error('down')); };
    init.signal?.addEventListener('abort', () => { c.aborted = true; if (!c.ignoreAbort) c.fail(); });
    calls.push(c);
  });
  return { calls, fetch };
}
async function withNet(fn) { const net = fakeNet(), orig = globalThis.fetch; globalThis.fetch = net.fetch; try { await fn(net); } finally { globalThis.fetch = orig; } }
// target 1 = DC 2; non-media prefers kws2, backup kws2-1
const A = 'kws2.web.telegram.org', B = 'kws2-1.web.telegram.org';
const go = (opts = {}) => W.dial({ target: 1, media: false, hedge: 40, ...opts });

test('dial: a fast primary is used alone, the backup is never started', () => withNet(async net => {
  const p = go();
  await until(() => net.calls.length === 1);
  assert.equal(net.calls[0].host, A);
  net.calls[0].ok();
  const wire = await p;
  await sleep(80); // well past the hedge delay
  assert.equal(net.calls.length, 1);
  await wire.write(new Uint8Array([1]));
  assert.equal(net.calls[0].ws.sent.length, 1);
  wire.close();
}));

test('dial: a slow primary starts the backup after the hedge delay; the backup wins and the primary is aborted', () => withNet(async net => {
  const t0 = Date.now(), p = go();
  await until(() => net.calls.length === 2);
  assert.ok(Date.now() - t0 >= 35, 'backup must wait for the hedge delay');
  assert.equal(net.calls[1].host, B);
  net.calls[1].ok();
  const wire = await p;
  assert.ok(net.calls[0].aborted, 'loser aborted');
  await wire.write(new Uint8Array([7]));
  assert.equal(net.calls[1].ws.sent.length, 1);
  assert.equal(net.calls[0].ws.sent.length, 0);
  wire.close();
}));

test('dial: a primary that fails before the hedge delay starts the backup at once', () => withNet(async net => {
  const p = go({ hedge: 1000 });
  await until(() => net.calls.length === 1);
  const t0 = Date.now(); net.calls[0].fail();
  await until(() => net.calls.length === 2, 300);
  assert.ok(Date.now() - t0 < 200);
  net.calls[1].ok();
  (await p).close();
}));

test('dial: when both succeed in the same tick only one is kept, the other is accepted and closed unused', () => withNet(async net => {
  const p = go();
  await until(() => net.calls.length === 2);
  net.calls[0].ignoreAbort = net.calls[1].ignoreAbort = true;
  net.calls[0].ok(); net.calls[1].ok();
  const wire = await p;
  await wire.write(new Uint8Array([1]));
  await sleep(5);
  const [win, lose] = net.calls[0].ws.sent.length ? net.calls : [net.calls[1], net.calls[0]];
  assert.equal(win.ws.sent.length, 1); assert.equal(win.ws.closedWith, null);
  assert.equal(lose.ws.sent.length, 0); assert.ok(lose.ws.accepted); assert.equal(lose.ws.closedWith, 1000);
  wire.close();
}));

test('dial: a loser that connects after the winner was chosen is closed without data', () => withNet(async net => {
  const p = go();
  await until(() => net.calls.length === 2);
  net.calls[0].ignoreAbort = true; // simulates an upgrade that completes despite the abort
  net.calls[1].ok();
  const wire = await p;
  net.calls[0].ok();
  await until(() => net.calls[0].ws.closedWith !== null);
  assert.equal(net.calls[0].ws.sent.length, 0);
  await wire.write(new Uint8Array([1]));
  assert.equal(net.calls[1].ws.closedWith, null, 'closing the loser must not touch the winner');
  wire.close();
}));

test('dial: aborting the stream aborts every candidate, rejects, and closes late arrivals', () => withNet(async net => {
  const ac = new AbortController(), p = go({ signal: ac.signal });
  await until(() => net.calls.length === 2);
  net.calls[1].ignoreAbort = true;
  ac.abort();
  await assert.rejects(p);
  assert.ok(net.calls.every(c => c.aborted));
  net.calls[1].ok();
  await until(() => net.calls[1].ws.closedWith !== null);
  assert.equal(net.calls[1].ws.sent.length, 0);
}));

test('dial: an already-aborted stream never dials', () => withNet(async net => {
  const ac = new AbortController(); ac.abort();
  await assert.rejects(go({ signal: ac.signal }));
  assert.equal(net.calls.length, 0);
}));

test('dial: fails only after both candidates failed', () => withNet(async net => {
  let done = false; const p = go().finally(() => { done = true; });
  await until(() => net.calls.length === 2);
  net.calls[0].fail(); await sleep(5);
  assert.equal(done, false);
  net.calls[1].fail();
  await assert.rejects(p);
}));

test('dial: a 101 that fails the upgrade checks is a failure (falls through to the backup) and its socket is closed', async () => {
  const orig = globalThis.fetch, socks = [];
  globalThis.fetch = async (url) => { const ws = new FakeUp(); socks.push(ws); const good = new URL(url).hostname === B;
    return { status: 101, webSocket: ws, headers: new Headers({ 'Sec-WebSocket-Protocol': good ? 'binary' : 'json' }) }; };
  try {
    const wire = await go({ hedge: 1000 });
    assert.equal(socks.length, 2);
    assert.ok(socks[0].accepted); assert.equal(socks[0].closedWith, 1002);
    await wire.write(new Uint8Array([1]));
    assert.equal(socks[1].sent.length, 1);
    wire.close();
  } finally { globalThis.fetch = orig; }
});

test('mkCfg: DIAL_HEDGE_MS defaults, overrides, clamps, and is part of the cache key', () => {
  const base = { SECRET: '0123456789abcdef0123456789abcdef', BOOT: 'hedge-boot' };
  assert.equal(W.mkCfg(base).hedge, W.CFG.hedgeMs);
  assert.equal(W.mkCfg({ ...base, DIAL_HEDGE_MS: '250' }).hedge, 250);
  assert.equal(W.mkCfg({ ...base, DIAL_HEDGE_MS: '0' }).hedge, 0);
  assert.equal(W.mkCfg({ ...base, DIAL_HEDGE_MS: '99999' }).hedge, 7500);
  assert.equal(W.mkCfg({ ...base, DIAL_HEDGE_MS: '-5' }).hedge, 0);
  assert.equal(W.mkCfg({ ...base, DIAL_HEDGE_MS: 'abc' }).hedge, W.CFG.hedgeMs);
});
