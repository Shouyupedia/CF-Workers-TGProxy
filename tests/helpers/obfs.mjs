// Test-side MTProto transport obfuscation helpers (client + KWS roles). Not used by the Worker.
const C = globalThis.crypto;
export const rand = n => C.getRandomValues(new Uint8Array(n));
export const cat = (...a) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
export const sha256 = async v => new Uint8Array(await C.subtle.digest('SHA-256', v));
export function addCtr(iv, n) {
  let v = 0n; for (const b of iv) v = (v << 8n) | BigInt(b);
  v = (v + BigInt(n)) & ((1n << 128n) - 1n);
  const out = new Uint8Array(16); for (let i = 15; i >= 0; i--) { out[i] = Number(v & 255n); v >>= 8n; } return out;
}
// Stateless-by-offset AES-CTR stream; offsets are reserved synchronously so calls may overlap.
export class CtrStream {
  constructor(key, iv) { this.key = C.subtle.importKey('raw', key, 'AES-CTR', false, ['encrypt']); this.iv = iv.slice(); this.off = 0; }
  async xor(data) {
    const off = this.off; this.off += data.length; const skip = off % 16;
    const buf = new Uint8Array(skip + data.length); buf.set(data, skip);
    const out = new Uint8Array(await C.subtle.encrypt({ name: 'AES-CTR', counter: addCtr(this.iv, Math.floor(off / 16)), length: 128 }, await this.key, buf));
    return out.subarray(skip);
  }
}
const BAD = new Set([0x44414548, 0x54534f50, 0x20544547, 0x4954504f, 0xeeeeeeee, 0xdddddddd, 0x02010316]);
export async function clientHandshake(secretHex, { mode = 0xee, dc = 2, media = false } = {}) {
  const secret = Uint8Array.from(secretHex.slice(-32).match(/../g), h => parseInt(h, 16));
  let head; for (;;) { head = rand(64); const dv = new DataView(head.buffer); if (head[0] !== 0xef && !BAD.has(dv.getUint32(0, true)) && dv.getUint32(4, true) !== 0) break; }
  head.fill(mode, 56, 60); new DataView(head.buffer).setInt16(60, media ? -dc : dc, true);
  const tx = new CtrStream(await sha256(cat(head.subarray(8, 40), secret)), head.subarray(40, 56));
  const rev = head.slice(8, 56).reverse();
  const rx = new CtrStream(await sha256(cat(rev.subarray(0, 32), secret)), rev.subarray(32, 48));
  const enc = await tx.xor(head); const wire = head.slice(); wire.set(enc.subarray(56), 56);
  return { wire, tx, rx };
}
// 0xee "intermediate" packet: u32le length + payload
export const pktEE = payload => { const p = new Uint8Array(4 + payload.length); new DataView(p.buffer).setUint32(0, payload.length, true); p.set(payload, 4); return p; };
