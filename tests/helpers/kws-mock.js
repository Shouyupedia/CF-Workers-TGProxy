// Minimal stand-in for Telegram KWS: de-obfuscates, echoes, and can "BLAST:<n>" n x 64 KiB downstream.
const C = crypto;
function addCtr(iv, n) { let v = 0n; for (const b of iv) v = (v << 8n) | BigInt(b); v = (v + BigInt(n)) & ((1n << 128n) - 1n); const o = new Uint8Array(16); for (let i = 15; i >= 0; i--) { o[i] = Number(v & 255n); v >>= 8n; } return o; }
class CtrStream { constructor(k, iv) { this.k = C.subtle.importKey('raw', k, 'AES-CTR', false, ['encrypt']); this.iv = iv.slice(); this.off = 0; }
  async xor(d) { const off = this.off; this.off += d.length; const s = off % 16; const b = new Uint8Array(s + d.length); b.set(d, s); return new Uint8Array(await C.subtle.encrypt({ name: 'AES-CTR', counter: addCtr(this.iv, Math.floor(off / 16)), length: 128 }, await this.k, b)).subarray(s); } }
const cat = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };
const log = [];
export default {
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/__log') return Response.json(log);
    if (url.pathname === '/__reset') { log.length = 0; return new Response('ok'); }
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('no', { status: 426 });
    const entry = { host: url.hostname, path: url.pathname, proto: req.headers.get('Sec-WebSocket-Protocol'), ext: req.headers.get('Sec-WebSocket-Extensions'), msgs: 0, bytes: 0 };
    log.push(entry);
    if (url.hostname.startsWith('kws5')) return new Response('down', { status: 502 }); // simulate an unreachable DC
    const { 0: client, 1: server } = new WebSocketPair(); server.binaryType = 'arraybuffer'; server.accept();
    let head = new Uint8Array(0), rx = null, tx = null, chain = Promise.resolve();
    const onMsg = async (b) => {
      if (!rx) { head = cat(head, b); if (head.length < 64) return; const h = head.subarray(0, 64);
        rx = new CtrStream(h.slice(8, 40), h.slice(40, 56)); const rev = h.slice(8, 56).reverse(); tx = new CtrStream(rev.slice(0, 32), rev.slice(32, 48));
        const dec = await rx.xor(h); entry.tag = dec[56]; entry.dc = new DataView(dec.buffer, dec.byteOffset).getInt16(60, true); b = head.subarray(64); if (!b.length) return; }
      entry.msgs++; entry.bytes += b.length; const plain = await rx.xor(b);
      const m = /BLAST:(\d+)/.exec(new TextDecoder().decode(plain.subarray(0, 64)));
      if (m) { const n = +m[1]; entry.blast = n; for (let i = 0; i < n; i++) { try { server.send(await tx.xor(new Uint8Array(65536).fill(i & 255))); } catch { entry.blastStopped = i; return; } } return; }
      server.send(await tx.xor(plain));
    };
    server.addEventListener('message', e => { chain = chain.then(() => onMsg(new Uint8Array(e.data))).catch(err => { entry.err = String(err); }); });
    server.addEventListener('close', () => { entry.closed = true; });
    return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': 'binary' } });
  },
};
