// Loads telegram_webproxy.js with its internals exported, without changing the deployable file.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// TGPROXY_WORKER=/path/to/other.js runs the same suite against another build (e.g. the previous release)
export const WORKER = process.env.TGPROXY_WORKER ? pathToFileURL(resolve(process.env.TGPROXY_WORKER)) : new URL('../../telegram_webproxy.js', import.meta.url);

export async function load(names) {
  const src = readFileSync(WORKER, 'utf8').replace(/^export default /m, 'const __default = ');
  const file = join(mkdtempSync(join(tmpdir(), 'tgproxy-')), 'worker.mjs');
  writeFileSync(file, `${src}\nexport { __default, ${names.join(', ')} };\n`);
  return import(file);
}
