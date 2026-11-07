// Manual check: this machine -> Telegram KWS directly (no Worker). Run: node tests/real/probe-kws.mjs [rounds]
// For every DC 1..5 and both host variants: time the WebSocket upgrade, then send req_pq_multi and expect resPQ.
// Note: if a local proxy/TUN answers DNS with fake IPs (e.g. 198.18.x.x), these timings include that proxy path.
import { hostsFor, ms, reqPqMulti, checkResPQ, plainHandshake, pktEE, eeReader } from './common.mjs';

const rounds = Number(process.argv[2] ?? 3);
const sleep = t => new Promise(r => setTimeout(r, t));

async function probe(host, dc, media) {
  const t0 = performance.now();
  const ws = new WebSocket(`wss://${host}/apiws`, 'binary'); ws.binaryType = 'arraybuffer';
  try {
    await new Promise((ok, bad) => { const timer = setTimeout(() => bad(Error('upgrade timeout')), 8000); ws.onopen = () => { clearTimeout(timer); ok(); }; ws.onerror = () => { clearTimeout(timer); bad(Error('upgrade failed')); }; });
    const tOpen = performance.now() - t0;
    if (ws.protocol !== 'binary') throw Error(`subprotocol ${JSON.stringify(ws.protocol)}`);
    const obf = await plainHandshake({ dc, media }), { msg, nonce } = reqPqMulti(), read = eeReader();
    const t1 = performance.now();
    const reply = new Promise((ok, bad) => { const timer = setTimeout(() => bad(Error('no reply')), 8000);
      ws.onmessage = async e => { const pk = read(await obf.rx.xor(new Uint8Array(e.data))); if (pk.length) { clearTimeout(timer); ok(pk[0]); } };
      ws.onclose = e => { clearTimeout(timer); bad(Error(`closed ${e.code}`)); }; });
    ws.send(obf.wire); ws.send(await obf.tx.xor(pktEE(msg)));
    const res = checkResPQ(await reply, nonce);
    return { ok: true, open: tOpen, rtt: performance.now() - t1, res };
  } catch (err) { return { ok: false, err: err.message, open: performance.now() - t0 }; }
  finally { try { ws.close(); } catch {} }
}

const rows = [];
for (let dc = 1; dc <= 5; dc++) for (const media of [false, true]) for (const [i, host] of hostsFor(dc, media).entries()) {
  const runs = [];
  for (let n = 0; n < rounds; n++) { runs.push(await probe(host, dc, media)); await sleep(150); }
  const good = runs.filter(r => r.ok), med = a => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
  rows.push({ dc, media, role: i ? 'backup' : 'primary', host, ok: `${good.length}/${runs.length}`, open: good.length ? ms(med(good.map(r => r.open))) : '-', rtt: good.length ? ms(med(good.map(r => r.rtt))) : '-', note: runs.find(r => !r.ok)?.err ?? good[0]?.res ?? '' });
}
console.table(rows);
const failed = rows.filter(r => !r.ok.startsWith(String(rounds)));
if (failed.length) { console.error(`${failed.length} host/mode combination(s) had failures`); process.exitCode = 1; }
