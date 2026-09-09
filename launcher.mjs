import fs from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { run } from './media.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const data = path.join(root, 'data');
await fs.mkdir(data, { recursive: true });
async function existingUrl() {
  try {
    const url = (await fs.readFile(path.join(data, 'url.txt'), 'utf8')).trim();
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) return null;
    const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return r.ok && (await r.text()).includes('pondGroups') ? url : null;
  } catch { return null; }
}
const current = await existingUrl();
if (current) {
  await run('powershell.exe', ['-NoProfile', '-Command', `Start-Process '${current}'`], { timeout: 15000 });
  console.log('Opened existing local downloader.');
} else {
  const out = openSync(path.join(data, 'server.log'), 'a');
  const err = openSync(path.join(data, 'server-error.log'), 'a');
  const child = spawn(process.execPath, ['server.mjs', '--open'], { cwd: root, windowsHide: true, detached: true, stdio: ['ignore', out, err] });
  child.unref(); closeSync(out); closeSync(err);
  let ready = false;
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 200));
    if (await existingUrl()) { ready = true; break; }
  }
  if (!ready) throw Error('Local downloader startup failed. See data/server-error.log.');
  console.log('Local downloader started.');
}
