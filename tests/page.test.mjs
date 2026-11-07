// Bridge page (the script served at /?bridge=) driven as the Telegram app would drive it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { start, bootstrap, Lane, T, SECRET } from './helpers/harness.mjs';
import { frame as W_frame } from './helpers/frames.mjs';
import { runPage } from './helpers/page.mjs';
import { clientHandshake, pktEE, cat } from './helpers/obfs.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const enc = s => new TextEncoder().encode(s);

async function withPage(bindings, opts, fn) {
  const h = await start(bindings);
  const { html } = await bootstrap(h);
  const p = runPage(h, html, opts);
  try { p.hello(); await p.until(a => a.frames.some(f => f.type === T.WELCOME)); await fn(p, h); } finally { await p.dispose(); await h.dispose(); }
}
async function stream(p, sid) {
  const obf = await clientHandshake(SECRET, { dc: 2 });
  p.send(T.OPEN, sid); p.send(T.DATA, sid, obf.wire);
  return {
    async echo(text) {
      const seen = p.app.frames.length;
      p.send(T.DATA, sid, await obf.tx.xor(pktEE(enc(text))));
      await p.until(a => a.frames.slice(seen).some(f => f.sid === sid && f.type === T.DATA));
      const data = p.app.frames.slice(seen).filter(f => f.sid === sid && f.type === T.DATA).map(f => f.payload);
      return new TextDecoder().decode((await obf.rx.xor(cat(...data))).subarray(4));
    },
  };
}
const closedFor = (p, sid) => p.app.frames.some(f => f.type === T.CLOSE && f.sid === sid);

test('page: session + lane relay through the Worker', () => withPage({}, {}, async p => {
  const s = await stream(p, 1);
  assert.equal(await s.echo('via-page'), 'via-page');
  assert.equal(p.app.status.at(-1), 'connected');
}));

test('page: renews the session token and can still open lanes after the first token expired', { timeout: 60000 }, () => withPage({ SESSION_TTL: '10' }, {}, async p => {
  const a = await stream(p, 1);
  await sleep(12500);
  assert.ok(p.calls.some(c => c.method === 'PUT'), 'PUT /api/v1/session issued');
  const b = await stream(p, 2);
  assert.equal(await b.echo('new-lane-after-ttl'), 'new-lane-after-ttl');
  assert.equal(await a.echo('old-lane'), 'old-lane');
  assert.equal(p.app.closed, false);
}));

test('page: a lane that cannot connect gets CLOSE alone; three in a row fail the session', () => withPage({}, { failSids: new Set([5, 6, 7, 8]) }, async p => {
  const ok = await stream(p, 1);
  p.send(T.OPEN, 5);
  await p.until(a => closedFor({ app: a }, 5));
  assert.equal(p.app.closed, false);
  assert.equal(await ok.echo('unaffected'), 'unaffected');
  for (const sid of [6, 7, 8]) p.send(T.OPEN, sid);
  await p.until(a => a.closed);
  assert.equal(p.app.status.at(-1), 'failed');
  assert.ok(p.calls.some(c => c.method === 'DELETE'));
}));

test('page: an over-limit or reused stream id gets CLOSE, the session stays up', () => withPage({}, { hangSids: new Set(Array.from({ length: 140 }, (_, i) => i + 10)) }, async p => {
  const ok = await stream(p, 1);
  for (let sid = 10; sid < 137; sid++) p.send(T.OPEN, sid); // 127 more lanes -> 128 total
  p.send(T.OPEN, 137);
  await p.until(a => closedFor({ app: a }, 137));
  assert.equal(closedFor(p, 136), false);
  p.send(T.CLOSE, 1);
  await sleep(200);
  p.send(T.OPEN, 1); // stream id already used
  await p.until(a => closedFor({ app: a }, 1));
  assert.equal(p.app.closed, false);
}));

test('page: closing sends DELETE and the Worker refuses that session afterwards', () => withPage({}, {}, async (p, h) => {
  await stream(p, 1);
  await p.until(() => p.calls.some(c => c.ws === 1));
  const token = p.calls.find(c => c.ws === 1).protocol.split('.')[1];
  p.close();
  await p.until(() => p.calls.some(c => c.method === 'DELETE'));
  await sleep(300);
  const lane = new Lane(h, token, 99); await lane.open();
  assert.equal(lane.status, 409);
}));

test('page: ignores non-OPEN frames for already-closed streams instead of crashing the session', () => withPage({}, {}, async p => {
  const s = await stream(p, 1);
  assert.equal(await s.echo('before'), 'before');
  p.send(T.OPEN, 2);
  p.send(T.CLOSE, 2);
  await sleep(100);
  p.send(T.WINDOW, 2, new Uint8Array([0, 1, 0, 0])); // late WINDOW for closed sid 2
  p.send(T.DATA, 2, new Uint8Array([1, 2, 3, 4]));   // late DATA for closed sid 2
  assert.equal(await s.echo('after'), 'after');
  assert.equal(p.app.closed, false);
}));

// PROTOCOL.md: the relay closes only the affected established lane for a malformed client message
test('page: a malformed frame on an established lane closes only that lane', () => withPage({}, {}, async p => {
  const ok = await stream(p, 1), a = await stream(p, 2), b = await stream(p, 3);
  assert.equal(await a.echo('a'), 'a'); assert.equal(await b.echo('b'), 'b');
  p.send(99, 2); // unknown frame type
  p.send(T.WINDOW, 3, new Uint8Array(4)); // zero WINDOW delta
  await p.until(a => closedFor({ app: a }, 2) && closedFor({ app: a }, 3));
  assert.equal(p.app.closed, false);
  assert.equal(await ok.echo('still-up'), 'still-up');
}));

test('page: lane closed before any frame ever opened does not count against openFails', () => withPage({}, { hangSids: new Set([10, 11, 12]), failSids: new Set([13, 14]) }, async p => {
  const ok = await stream(p, 1);
  for (const sid of [10, 11, 12]) { p.send(T.OPEN, sid); p.send(T.CLOSE, sid); }
  await sleep(100);
  // Two real connection failures should not trip the 3-failure threshold because 10,11,12 were cancelled by client
  for (const sid of [13, 14]) p.send(T.OPEN, sid);
  await p.until(a => closedFor({ app: a }, 14));
  assert.equal(p.app.closed, false);
  assert.equal(await ok.echo('still-up'), 'still-up');
}));

test('page: lane where client sends CLOSE after open does not emit duplicate CLOSE back to app on normal ws close', () => withPage({}, {}, async p => {
  const s = await stream(p, 1);
  assert.equal(await s.echo('hi'), 'hi');
  p.send(T.CLOSE, 1);
  await sleep(200);
  assert.equal(closedFor(p, 1), false);
}));

test('page: batching OPEN + DATA + CLOSE for a stream in a single message never opens a wasted WebSocket', () => withPage({}, {}, async p => {
  await stream(p, 1);
  await p.until(() => p.calls.some(c => c.ws === 1));
  const f1 = W_frame(T.OPEN, 2), f2 = W_frame(T.DATA, 2, new Uint8Array([1, 2, 3, 4])), f3 = W_frame(T.CLOSE, 2);
  const batch = cat(f1, f2, f3);
  p.sendRaw(batch);
  await sleep(100);
  assert.equal(p.calls.some(c => c.ws === 2), false, 'no WebSocket created for stream opened and closed in same batch');
}));

test('page: a closed lane whose socket is still flushing keeps counting against the 32 MiB uplink budget', () => withPage({}, {}, async p => {
  for (let sid = 2; sid <= 20 && !p.app.closed; sid++) {
    p.send(T.OPEN, sid);
    await p.until(() => p.isOpen(sid) || p.app.closed);
    p.setBuffered(sid, 2 * 1024 * 1024); // socket stalled with 2 MiB still unsent
    p.send(T.CLOSE, sid); // the CLOSE frame queues behind those bytes, so the socket stays open
  }
  await p.until(a => a.closed); // 16 stalled lanes x 2 MiB reach the 32 MiB bound
  assert.equal(p.app.status.at(-1), 'failed');
}));

test('page: a single batch of >1024 frames on an open lane drains per frame without tripping laneItems', () => withPage({}, {}, async p => {
  const s = await stream(p, 1);
  assert.equal(await s.echo('ready'), 'ready');
  // A carrier batch may hold up to 4096 frames while laneItems is 1024; on an open, unblocked socket each frame sends immediately
  const one = W_frame(T.WINDOW, 1, new Uint8Array([0, 0, 0, 1]));
  const batch = new Uint8Array(1100 * one.byteLength);
  for (let i = 0; i < 1100; i++) batch.set(one, i * one.byteLength);
  p.sendRaw(batch);
  assert.equal(await s.echo('after-1100-frames'), 'after-1100-frames');
  assert.equal(p.app.closed, false);
}));
