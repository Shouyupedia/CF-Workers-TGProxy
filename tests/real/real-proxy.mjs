// Manual check: client -> Worker (local Miniflare) -> REAL Telegram KWS. Run: node tests/real/real-proxy.mjs [rounds]
// The Worker's outbound goes through a pass-through "tap" Worker that only records which KWS host was contacted and when,
// then forwards the request unchanged to the internet. Each lane sends req_pq_multi and must get resPQ back from Telegram.
import { Miniflare } from 'miniflare';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WORKER } from '../helpers/load.mjs';
import { SECRET, BOOT, HOST, bootstrap, session, Lane, T } from '../helpers/harness.mjs';
import { hostsFor, ms, reqPqMulti, checkResPQ, pktEE, eeReader } from './common.mjs';

const rounds = Number(process.argv[2] ?? 2);
const TAP = `const log = [];
export default { async fetch(req) {
  const url = new URL(req.url);
  if (url.hostname === 'tap.local') { if (url.pathname === '/reset') log.length = 0; return Response.json(log); }
  const e = { host: url.hostname, t0: Date.now() }; log.push(e);
  try { const res = await fetch(req); e.status = res.status; e.ms = Date.now() - e.t0; return res; }
  catch (err) { e.err = String(err); e.ms = Date.now() - e.t0; throw err; } } };`;

async function run(hedge) {
  const mf = new Miniflare({ workers: [
    { name: 'main', modules: true, script: readFileSync(fileURLToPath(WORKER), 'utf8'), compatibilityDate: '2026-07-01', bindings: { SECRET, BOOT, DIAL_HEDGE_MS: String(hedge) }, outboundService: 'tap' },
    { name: 'tap', modules: true, script: TAP, compatibilityDate: '2026-07-01' },
  ] });
  await mf.ready;
  const tap = await mf.getWorker('tap');
  const h = { fetch: (p, init) => mf.dispatchFetch(`https://${HOST}${p}`, init) };
  const rows = [];
  try {
    const s = await session(h, (await bootstrap(h)).boot);
    if (s.status !== 200) throw Error(`session ${s.status}`);
    let sid = 0;
    for (let r = 0; r < rounds; r++) for (let dc = 1; dc <= 5; dc++) for (const media of [false, true]) {
      await tap.fetch('http://tap.local/reset');
      const lane = new Lane(h, s.token, ++sid); const t0 = performance.now();
      await lane.open(); if (lane.status !== 101) { rows.push({ hedge, dc, media, result: `lane ${lane.status}` }); continue; }
      await lane.handshake({ dc, media });
      const { msg, nonce } = reqPqMulti(); await lane.sendPacket(msg);
      let result;
      try {
        await lane.until(l => l.frames.some(f => f.type === T.DATA) || l.closed, 15000);
        const [pk] = eeReader()(await lane.readPlain());
        result = pk ? checkResPQ(pk, nonce) : `closed without reply`;
      } catch (err) { result = `FAIL ${err.message}`; }
      const total = performance.now() - t0;
      lane.close();
      await new Promise(r => setTimeout(r, 300));
      const log = await (await tap.fetch('http://tap.local/')).json(), [p, b] = hostsFor(dc, media);
      const fmt = e => e ? `${e.status ?? 'err'} @+${e.t0 - log[0].t0}ms (${e.ms ?? '?'}ms)` : 'not started';
      rows.push({ hedge, dc, media, result, total: ms(total), primary: fmt(log.find(e => e.host === p)), backup: fmt(log.find(e => e.host === b)) });
    }
  } finally { await mf.dispose(); }
  return rows;
}

const all = [];
for (const hedge of [Number(process.env.DIAL_HEDGE_MS ?? 1500), 0]) { const rows = await run(hedge); console.log(`\nDIAL_HEDGE_MS=${hedge}`); console.table(rows); all.push(...rows); }
const bad = all.filter(r => r.result !== 'resPQ ok');
if (bad.length) { console.error(`${bad.length} lane(s) did not get a valid resPQ through the Worker`); process.exitCode = 1; }
else console.log(`\nall ${all.length} lanes got a valid resPQ from Telegram through the Worker`);
