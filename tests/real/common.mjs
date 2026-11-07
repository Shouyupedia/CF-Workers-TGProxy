// Shared helpers for the manual "real Telegram" checks. Nothing here is used by the Worker or by `npm test`.
import { CtrStream, rand, cat } from '../helpers/obfs.mjs';

export const hostsFor = (dc, media) => [`kws${dc}${media ? '-1' : ''}.web.telegram.org`, `kws${dc}${media ? '' : '-1'}.web.telegram.org`];
export const ms = t => `${Math.round(t)} ms`;

// unauthenticated MTProto message: auth_key_id=0 | msg_id | len | req_pq_multi#be7e8ef1 nonce:int128
export function reqPqMulti() {
  const nonce = rand(16), body = new Uint8Array(20), dv = new DataView(body.buffer);
  dv.setUint32(0, 0xbe7e8ef1, true); body.set(nonce, 4);
  const msg = new Uint8Array(20 + body.length), mv = new DataView(msg.buffer);
  const now = Date.now(); mv.setUint32(8, (now % 1000) * 4294967 & ~3, true); mv.setUint32(12, Math.floor(now / 1000), true);
  mv.setUint32(16, body.length, true); msg.set(body, 20);
  return { msg, nonce };
}
// expects resPQ#05162463 echoing our nonce; returns a short description or throws
export function checkResPQ(payload, nonce) {
  if (payload.length < 40) throw Error(`short reply (${payload.length} bytes)`);
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  if (dv.getUint32(0, true) !== 0 || dv.getUint32(4, true) !== 0) throw Error('reply is not an unencrypted message');
  const ctor = dv.getUint32(20, true);
  if (ctor !== 0x05162463) throw Error(`unexpected constructor 0x${ctor.toString(16)}`);
  if (!payload.subarray(24, 40).every((b, i) => b === nonce[i])) throw Error('nonce mismatch');
  return 'resPQ ok';
}
// client side of the plain (no secret) transport obfuscation, as Web K speaks it to kws*
export async function plainHandshake({ mode = 0xee, dc = 2, media = false } = {}) {
  const BAD = new Set([0x44414548, 0x54534f50, 0x20544547, 0x4954504f, 0xeeeeeeee, 0xdddddddd, 0x02010316]);
  let head; for (;;) { head = rand(64); const dv = new DataView(head.buffer); if (head[0] !== 0xef && !BAD.has(dv.getUint32(0, true)) && dv.getUint32(4, true) !== 0) break; }
  head.fill(mode, 56, 60); new DataView(head.buffer).setInt16(60, media ? -dc : dc, true);
  const tx = new CtrStream(head.slice(8, 40), head.slice(40, 56));
  const rev = head.slice(8, 56).reverse(); const rx = new CtrStream(rev.slice(0, 32), rev.slice(32, 48));
  const enc = await tx.xor(head); const wire = head.slice(); wire.set(enc.subarray(56), 56);
  return { wire, tx, rx };
}
export const pktEE = p => { const o = new Uint8Array(4 + p.length); new DataView(o.buffer).setUint32(0, p.length, true); o.set(p, 4); return o; };
// reassembles 0xee packets from a decrypted byte stream
export function eeReader() { let buf = new Uint8Array(0); return chunk => { buf = cat(buf, chunk); const out = []; for (;;) { if (buf.length < 4) break; const n = new DataView(buf.buffer, buf.byteOffset).getUint32(0, true) & 0x7fffffff; if (buf.length < 4 + n) break; out.push(buf.slice(4, 4 + n)); buf = buf.slice(4 + n); } return out; }; }
