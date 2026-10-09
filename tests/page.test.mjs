// Bridge page (the script served at /?bridge=) driven as the Telegram app would drive it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { start, bootstrap, Lane, T, SECRET } from './helpers/harness.mjs';
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
