export const T = { OPEN: 1, DATA: 2, CLOSE: 3, WINDOW: 4, HELLO: 0x10, WELCOME: 0x11 };
export function frame(type, sid, payload = new Uint8Array(0)) {
  const f = new Uint8Array(8 + payload.length); f[0] = type; f[1] = sid >>> 16; f[2] = sid >>> 8; f[3] = sid;
  new DataView(f.buffer).setUint32(4, payload.length, false); f.set(payload, 8); return f;
}
export const u32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, false); return b; };
export function parse(buf) {
  const b = new Uint8Array(buf), out = []; let o = 0;
  while (o < b.length) { const n = new DataView(b.buffer, b.byteOffset + o).getUint32(4, false); out.push({ type: b[o], sid: (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3], payload: b.slice(o + 8, o + 8 + n) }); o += 8 + n; }
  return out;
}
export const hello = () => frame(T.HELLO, 0, new Uint8Array([1]));
