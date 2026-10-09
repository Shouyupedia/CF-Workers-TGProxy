import { Miniflare } from 'miniflare';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { frame, parse, hello, T, u32 } from './frames.mjs';
import { clientHandshake, pktEE, cat } from './obfs.mjs';
import { WORKER } from './load.mjs';

export const HOST = 'proxy.example.com';
export const SECRET = '000102030405060708090a0b0c0d0e0f'; // PROTOCOL.md test vector secret
export const BRIDGE = 'MHLEY5PmW1GWqJkSrlmJpvJUiLhBH_QKy6yKg8a0JPk';
export const BOOT = 'test-boot-key-0123456789abcdef0123456789';
const KWS = readFileSync(fileURLToPath(new URL('./kws-mock.js', import.meta.url)), 'utf8');

export async function start(bindings = {}, extra = {}, workerPath = fileURLToPath(WORKER)) {
  const mf = new Miniflare({
    workers: [
      { name: 'main', modules: true, script: readFileSync(workerPath, 'utf8'), compatibilityDate: '2026-07-01', bindings: { SECRET, BOOT, ...bindings }, outboundService: 'kws', ...extra },
      { name: 'kws', modules: true, script: KWS, compatibilityDate: '2026-07-01' },
    ],
  });
  await mf.ready;
  const kws = await mf.getWorker('kws');
  return {
    mf,
    fetch: (path, init) => mf.dispatchFetch(`https://${HOST}${path}`, init),
    kwsLog: async () => (await kws.fetch('http://kws.local/__log')).json(),
    kwsReset: () => kws.fetch('http://kws.local/__reset'),
    dispose: () => mf.dispose(),
  };
}

export async function bootstrap(h, bridge = BRIDGE) {
  const res = await h.fetch(`/?bridge=${bridge}`);
  const html = await res.text();
  const m = /boot=("[A-Za-z0-9_-]+")/.exec(html);
  return { status: res.status, boot: m ? JSON.parse(m[1]) : null, html, headers: res.headers };
}

export async function session(h, boot, headers = {}) {
  const body = hello();
  const res = await h.fetch('/api/v1/session', { method: 'POST', body, headers: { Authorization: `Bearer ${boot}`, 'Content-Type': 'application/octet-stream', ...headers } });
  const buf = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, token: res.headers.get('X-Session-Token'), ttl: res.headers.get('X-Session-Ttl'), body: buf, headers: res.headers };
}

export class Lane {
  constructor(h, token, sid) { this.h = h; this.token = token; this.sid = sid; this.frames = []; this.closed = false; this.waiters = []; this.down = 0; }
  async open({ protocol } = {}) {
    const res = await this.h.fetch('/api/v1/ws', { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': protocol ?? `tproxy-lane-v1.${this.token}.${this.sid}` } });
    this.status = res.status; if (res.status !== 101) return false;
    this.ws = res.webSocket; this.ws.accept();
    this.ws.addEventListener('message', e => { for (const f of parse(e.data)) { this.frames.push(f); if (f.type === T.DATA) this.down += f.payload.length; } this.poke(); });
    this.ws.addEventListener('close', e => { this.closed = true; this.closeCode = e.code; this.poke(); });
    return true;
  }
  poke() { for (const w of this.waiters.splice(0)) w(); }
  send(type, payload) { this.ws.send(frame(type, this.sid, payload)); }
  async until(pred, ms = 5000) {
    const end = Date.now() + ms;
    while (!pred(this)) { if (Date.now() > end) throw new Error(`timeout; frames=${this.frames.map(f => f.type).join(',')} closed=${this.closed}`); await new Promise(ok => { this.waiters.push(ok); setTimeout(ok, 50); }); }
  }
  // Client-side MTProto transport on top of the lane
  async handshake(opts) { this.obf = await clientHandshake(opts?.secret ?? SECRET, opts); this.send(T.OPEN); this.send(T.DATA, this.obf.wire); }
  async sendPacket(payload) { this.send(T.DATA, await this.obf.tx.xor(pktEE(payload))); }
  async readPlain() { const data = this.frames.filter(f => f.type === T.DATA).map(f => f.payload); this.frames = this.frames.filter(f => f.type !== T.DATA); return data.length ? this.obf.rx.xor(cat(...data)) : new Uint8Array(0); }
  grant(n) { this.send(T.WINDOW, u32(n)); }
  close() { try { this.ws.close(1000); } catch {} }
}
export { T, u32, pktEE };
