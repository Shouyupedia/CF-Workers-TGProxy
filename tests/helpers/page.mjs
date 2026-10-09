// Runs the bridge page script in Node with just enough browser surface (fetch, WebSocket, postMessage port)
// wired to the Worker under Miniflare, and plays the Telegram app on the other end of the MessagePort.
import { MessageChannel } from 'node:worker_threads';
import { frame, parse, hello, T } from './frames.mjs';
import { HOST } from './harness.mjs';

export function runPage(h, html, { failSids = new Set(), hangSids = new Set() } = {}) {
  const code = /<script nonce="[^"]+">([\s\S]*)<\/script>/.exec(html)[1];
  const listeners = {}, calls = [];
  const parent = {};
  const fetchMock = async (url, init = {}) => {
    calls.push({ url, method: init.method });
    return h.mf.dispatchFetch(url, { method: init.method, headers: init.headers, body: init.body ?? undefined });
  };
  class FakeWebSocket {
    static OPEN = 1;
    constructor(url, protocol) {
      this.readyState = 0; this.bufferedAmount = 0; this.protocol = protocol;
      const sid = Number(protocol.split('.')[2]);
      calls.push({ url, ws: sid, protocol });
      if (hangSids.has(sid)) return;
      queueMicrotask(async () => {
        if (failSids.has(sid)) { this.readyState = 3; this.onerror?.({}); this.onclose?.({ code: 1006 }); return; }
        const res = await h.mf.dispatchFetch(url.replace(/^wss:/, 'https:'), { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': protocol } });
        if (res.status !== 101) { this.readyState = 3; this.onerror?.({}); this.onclose?.({ code: 1006 }); return; }
        const ws = this.ws = res.webSocket; ws.accept();
        ws.addEventListener('message', e => this.onmessage?.({ data: e.data }));
        ws.addEventListener('close', e => { this.readyState = 3; this.onclose?.({ code: e.code }); });
        this.readyState = 1; this.onopen?.({});
      });
    }
    send(v) { this.ws.send(v); }
    close() { if (this.readyState === 3) return; this.readyState = 3; try { this.ws?.close(1000); } catch {} }
  }
  const env = {
    location: { hash: '', pathname: '/' }, history: { replaceState() {} }, parent,
    addEventListener: (t, fn) => { listeners[t] = fn; },
    fetch: fetchMock, WebSocket: FakeWebSocket, globalThis: {},
  };
  new Function(...Object.keys(env), code)(...Object.values(env));

  // the "Telegram app" side
  const { port1: app, port2 } = new MessageChannel();
  const app$ = { frames: [], status: [], closed: false, waiters: [] };
  app.on('message', data => {
    if (data instanceof ArrayBuffer) app$.frames.push(...parse(data));
    else if (data?.t === 'status') app$.status.push(data.state);
    else if (data?.t === 'close') app$.closed = true;
    for (const w of app$.waiters.splice(0)) w();
  });
  listeners.message({ source: parent, origin: 'http://127.0.0.1:41234', data: { t: 'tproxy-init', v: 1 }, ports: [port2] });
  return {
    calls, app: app$,
    send: (type, sid, payload) => { const f = frame(type, sid, payload); app.postMessage(f.buffer, [f.buffer]); },
    hello() { const f = hello(); app.postMessage(f.buffer, [f.buffer]); },
    async until(pred, ms = 5000) { const end = Date.now() + ms; while (!pred(app$)) { if (Date.now() > end) throw new Error(`timeout: frames=${app$.frames.map(f => `${f.type}@${f.sid}`).join(',')} status=${app$.status.at(-1)} closed=${app$.closed}`); await new Promise(ok => { app$.waiters.push(ok); setTimeout(ok, 50); }); } },
    close() { app.postMessage({ t: 'close' }); },
    pagehide() { listeners.pagehide?.(); },
    async dispose() { try { app.postMessage({ t: 'close' }); } catch {} await new Promise(r => setTimeout(r, 100)); app.close(); port2.close(); },
    host: HOST,
  };
}
