import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { defaultConfig, validateConfig, makePlan, recoverJob, absoluteFolder, byteRange } from './core.mjs';
import { run, hash, verify, transcode, deliver } from './media.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.HIK_DATA_DIR || path.join(ROOT, 'data');
await fs.mkdir(path.join(DATA, 'jobs'), { recursive: true });
const lockPath = path.join(DATA, 'server.lock');
try {
  const lock = await fs.open(lockPath, 'wx'); await lock.writeFile(String(process.pid)); await lock.close();
} catch (e) {
  if (e.code !== 'EEXIST') throw e;
  const pid = Number(await fs.readFile(lockPath, 'utf8'));
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch (err) { if (err.code !== 'ESRCH') alive = true; }
  if (alive) throw Error('后台已运行，请重新使用 Start.cmd 打开页面');
  await fs.unlink(lockPath);
  const lock = await fs.open(lockPath, 'wx'); await lock.writeFile(String(process.pid)); await lock.close();
}
const token = crypto.randomBytes(32).toString('hex');
let config = defaultConfig(), active = null, origin = '', mutationBusy = false;
try { config = validateConfig(JSON.parse(await fs.readFile(path.join(DATA, 'config.json'), 'utf8'))); } catch (e) { if (e.code !== 'ENOENT') throw Error('配置文件损坏，请保留文件并修复 config.json'); }
const jobs = new Map();
async function atomic(file, data) {
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2)); await fs.rename(tmp, file);
}
async function save(job) { job.updatedAt = new Date().toISOString(); await atomic(path.join(DATA, 'jobs', `${job.id}.json`), job); }
for (const name of await fs.readdir(path.join(DATA, 'jobs'))) {
  if (!/^[\da-f-]+\.json$/.test(name)) continue;
  try { const j = recoverJob(JSON.parse(await fs.readFile(path.join(DATA, 'jobs', name), 'utf8'))); jobs.set(j.id, j); await save(j); }
  catch { console.error(`无法读取任务文件：${name}；原文件未修改`); }
}
const safeError = e => e.code === 'ENOSPC' ? '磁盘空间不足' : e.code === 'ENOENT' ? '文件、目录或依赖程序不存在' : e.message;
const summary = j => ({ id: j.id, status: j.status, createdAt: j.createdAt, updatedAt: j.updatedAt,
  outputDir: j.outputDir, total: j.clips.length, complete: j.clips.filter(c => c.status === 'complete').length, error: j.error });
async function report(job) {
  // Report writes are part of acceptance, not best-effort side effects.
  const clean = { id: job.id, status: job.status, deviceIp: job.deviceIp, sdkPort: job.sdkPort, createdAt: job.createdAt,
    check: '快速校验：容器、编码、时长、首帧；复制 SHA256。未检查全片解码或画面内容。', clips: job.clips };
  await atomic(path.join(job.outputDir, '任务清单.json'), clean);
  const cell = v => `"${String(v ?? '').replaceAll('"', '""')}"`;
  const rows = [['鱼池', '通道', '开始时间', '结束时间', '文件', '状态', '实际秒数', 'SHA256', '说明'],
    ...job.clips.map(c => [c.pool, c.channel, c.start, c.end, c.filename, c.status, c.validation?.duration, c.sha256, c.error || c.validation?.check])];
  const csvPath = path.join(job.outputDir, '校验报告.csv');
  const tmp = `${csvPath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, '\ufeff' + rows.map(r => r.map(cell).join(',')).join('\r\n')); await fs.rename(tmp, csvPath);
}
async function storageCheck(folder) {
  await fs.mkdir(folder, { recursive: true });
  const test = path.join(folder, `.hik-write-test-${crypto.randomUUID()}`);
  await fs.writeFile(test, 'ok', { flag: 'wx' }); await fs.unlink(test);
  const s = await fs.statfs(folder); if (s.bavail * s.bsize < 64 * 1024 * 1024) throw Error('磁盘剩余空间不足 64 MB');
}
async function dependencies(c) {
  const dll = await fs.readFile(path.join(c.sdkDir, 'HCNetSDK.dll'));
  const machine = dll.readUInt16LE(dll.readUInt32LE(60) + 4);
  if (machine !== 0x8664) throw Error('首版需要 64 位 HCNetSDK，请选择对应 SDK 目录');
  for (const exe of ['ffmpeg', 'ffprobe']) { const r = await run(exe, ['-version'], { timeout: 10000 }); if (r.code) throw Error(`${exe} 不可用`); }
}
function credentials(v) {
  if (!v || typeof v.username !== 'string' || !v.username || typeof v.password !== 'string' || !v.password || v.username.length > 128 || v.password.length > 256) throw Error('请输入用户名和密码');
  return { username: v.username, password: v.password };
}
async function download(job, clip, raw, auth, ctx) {
  const fields = [job.deviceIp, job.sdkPort, job.sdkDir, auth.username, auth.password, clip.channel, clip.start, clip.end, raw, ctx.cancelPath];
  const input = fields.map(s => Buffer.from(String(s), 'utf8').toString('base64')).join('\n') + '\n';
  // Cancellation uses a file so the worker reaches its SDK finally block; hard timeout is last resort.
  const result = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'download-worker.ps1')], {
    input, timeout: 3660000, onLine: line => { const m = /^PROGRESS:(\d+)$/.exec(line.trim()); if (m) clip.progress = Math.min(100, Number(m[1])); }
  });
  if (ctx.controller.signal.aborted) throw Error('已取消');
  const status = result.stdout.match(/RESULT:([^\r\n]+)/)?.[1] || 'worker_failed';
  const sdkCode = status.split(':')[1];
  const detail = { 1: '用户名或密码错误', 5: '设备连接数达到上限', 7: '无法连接录像机', 10: '录像机接收超时', 17: 'SDK 参数错误', 34: '无法创建本地录像文件' }[sdkCode];
  if (result.code !== 0 || !status.startsWith('ok:')) throw Error(status.startsWith('ascii_cache_required') ? 'SDK 不支持此缓存路径，请选择英文缓存目录' : `下载失败：${detail || status}（SDK 错误码 ${sdkCode || '未知'}）`);
}
async function cleanup(paths) { for (const p of paths) await fs.unlink(p).catch(() => {}); }
async function execute(job, auth, ctx, onlyVerify) {
  const signal = ctx.controller.signal;
  try {
    job.error = ''; job.status = onlyVerify ? 'verifying' : 'running'; await save(job);
    await storageCheck(job.outputDir);
    if (!onlyVerify) { await dependencies(job); await storageCheck(job.cacheDir); }
    for (const clip of job.clips) {
      if (signal.aborted) break;
      const target = path.join(job.outputDir, clip.filename), raw = path.join(job.cacheDir, clip.filename.replace('.mp4', '.ps'));
      const standard = `${raw}.standard.mp4`;
      clip.error = ''; clip.progress = 0;
      try {
        if (onlyVerify || clip.sha256) {
          clip.status = 'verifying'; await save(job);
          try {
            if (!clip.sha256) throw Error('缺少原始校验基线，不能证明复制一致');
            const validation = await verify(target, clip.seconds, signal);
            if (await hash(target, signal) !== clip.sha256) throw Error('文件 SHA256 与已保存基线不符，未覆盖文件');
            clip.validation = { ...clip.validation, ...validation, size: (await fs.stat(target)).size, verifiedAt: new Date().toISOString() }; clip.status = 'complete';
            if (!onlyVerify) await cleanup([raw, `${raw}.partial`, standard]);
            await save(job); await report(job); continue;
          } catch (e) { if (onlyVerify || e.code !== 'ENOENT') throw e; }
        }
        for (let attempt = 1; attempt <= 3; attempt++) {
          clip.attempt = attempt;
          try {
            if (signal.aborted) throw Error('已取消');
            await storageCheck(job.cacheDir); await storageCheck(job.outputDir);
            let rawReady = clip.rawSha256 && await hash(raw, signal).catch(() => '') === clip.rawSha256;
            if (!rawReady) {
              // Only generated cache files belonging to this task may be replaced.
              await cleanup([raw, `${raw}.partial`, standard]); clip.rawSha256 = null;
              clip.status = 'downloading'; await save(job);
              await download(job, clip, raw, auth, ctx);
              clip.rawSha256 = await hash(raw, signal); await save(job);
            }
            clip.status = 'transcoding'; await save(job);
            const conversion = await transcode(raw, standard, clip.seconds, signal);
            clip.status = 'copying'; clip.sha256 = await hash(standard, signal); await save(job);
            const validation = await deliver(standard, target, clip.seconds, signal, clip.sha256);
            clip.validation = { ...conversion, ...validation }; clip.status = 'complete'; clip.progress = 100; clip.error = '';
            await save(job); await report(job);
            await cleanup([raw, `${raw}.partial`, standard]);
            break;
          } catch (e) {
            if (/时长不符|无法读取视频结构|转码均失败/.test(e.message)) clip.rawSha256 = null;
            if (signal.aborted || attempt === 3 || /已有目标|哈希|SHA256|空间|路径/.test(e.message)) throw e;
            clip.status = 'retrying'; clip.error = safeError(e); await save(job);
            await new Promise(resolve => { const t = setTimeout(done, 3000); function done() { clearTimeout(t); signal.removeEventListener('abort', done); resolve(); } signal.addEventListener('abort', done, { once: true }); });
          }
        }
      } catch (e) { clip.status = signal.aborted ? 'cancelled' : 'failed'; clip.error = safeError(e); }
      await save(job); await report(job);
    }
    job.status = signal.aborted ? 'cancelled' : job.clips.every(c => c.status === 'complete') ? 'complete' : 'partial';
    await report(job);
  } catch (e) { job.status = signal.aborted ? 'cancelled' : 'failed'; job.error = safeError(e); }
  finally {
    auth.password = ''; auth.username = '';
    await save(job).catch(() => {});
    await fs.unlink(ctx.cancelPath).catch(() => {});
    if (active === ctx) active = null;
  }
}
async function start(job, auth, onlyVerify = false) {
  if (job.mappingInvalid) throw Error('该历史样片的通道映射已证实有误，请使用已纠正的配置创建新任务');
  if (active) throw Error('已有任务运行，请等待完成或先取消');
  const ctx = { id: job.id, controller: new AbortController(), cancelPath: path.join(DATA, `cancel-${job.id}`) };
  active = ctx;
  await fs.unlink(ctx.cancelPath).catch(() => {});
  void execute(job, auth, ctx, onlyVerify);
}
const server = http.createServer(async (req, res) => {
  let mutationHeld = false;
  const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  try {
    if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: '请求来源不允许' });
    if (req.url === '/' && req.method === 'GET') {
      const html = (await fs.readFile(path.join(ROOT, 'index.html'), 'utf8')).replace('__TOKEN__', token);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Set-Cookie': `hik_session=${token}; HttpOnly; SameSite=Strict; Path=/`, 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; media-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" }); return res.end(html);
    }
    const media = /^\/media\/([\da-f-]+)\/(\d+)$/.exec(req.url);
    if (media && req.method === 'GET') {
      if (!req.headers.cookie?.split(';').some(c => c.trim() === `hik_session=${token}`)) return send(403, { error: '视频会话失效，请刷新页面' });
      const job = jobs.get(media[1]), clip = job?.clips[Number(media[2])];
      if (!clip || clip.status !== 'complete' || job.mappingInvalid) return send(404, { error: '视频尚未验证完成' });
      const file = path.join(job.outputDir, clip.filename), { size } = await fs.stat(file);
      let range;
      try { range = byteRange(req.headers.range, size); } catch { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
      res.writeHead(range ? 206 : 200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
        'Content-Length': range ? range.end - range.start + 1 : size, ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${size}` } : {}) });
      const stream = createReadStream(file, range || {});
      stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res); return;
    }
    if (req.headers['x-session-token'] !== token) return send(403, { error: '会话失效，请刷新页面' });
    let body = {};
    if (req.method === 'POST') {
      if (req.headers['content-type'] !== 'application/json') return send(415, { error: '仅接受 JSON' });
      let bytes = 0, chunks = [];
      for await (const b of req) { bytes += b.length; if (bytes > 200000) throw Error('请求过大'); chunks.push(b); }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (!['/api/folder', '/api/preview', '/api/directories'].includes(req.url)) {
        if (mutationBusy) throw Error('另一项操作正在提交，请稍后重试');
        mutationBusy = true; mutationHeld = true;
      }
    }
    if (req.url === '/api/config' && req.method === 'GET') return send(200, { config, defaultCache: path.join(os.tmpdir(), 'HikvisionCache'), active: active?.id || null });
    if (req.url === '/api/config' && req.method === 'POST') { config = validateConfig(body); await atomic(path.join(DATA, 'config.json'), config); return send(200, config); }
    if (req.url === '/api/directories' && req.method === 'POST') {
      if (!body.path) {
        const drives = await Promise.all(Array.from({ length: 26 }, (_, i) => `${String.fromCharCode(65 + i)}:\\`).map(async p => {
          try { await fs.access(p); return { name: p, path: p }; } catch { return null; }
        }));
        return send(200, { path: '', parent: null, directories: drives.filter(Boolean) });
      }
      const folder = absoluteFolder(body.path), entries = await fs.readdir(folder, { withFileTypes: true });
      const directories = entries.filter(e => e.isDirectory()).map(e => ({ name: e.name, path: path.join(folder, e.name) })).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
      const parent = path.dirname(folder);
      return send(200, { path: folder, parent: parent === folder ? '' : parent, directories });
    }
    if (req.url === '/api/folder' && req.method === 'POST') {
      const r = await run('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'choose-folder.ps1')], { timeout: 180000 });
      if (r.code !== 0) throw Error('系统文件夹选择器启动失败，请在输入框粘贴完整路径');
      return send(200, { path: Buffer.from(r.stdout.trim(), 'base64').toString('utf8') });
    }
    if (req.url === '/api/preview' && req.method === 'POST') return send(200, makePlan(body, config));
    if (req.url === '/api/jobs' && req.method === 'GET') return send(200, [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(summary));
    if (req.url === '/api/jobs' && req.method === 'POST') {
      const plan = makePlan(body, config), auth = credentials(body);
      if (body.expectedFingerprint !== plan.fingerprint) throw Error('参数或通道配置已改变，请重新预览');
      if (active) throw Error('已有任务运行');
      const previous = [...jobs.values()].find(j => j.fingerprint === plan.fingerprint);
      if (previous) return send(200, { ...summary(previous), duplicate: true });
      const id = crypto.randomUUID();
      const job = { ...plan, id, createdAt: new Date().toISOString(), status: 'queued',
        outputDir: path.join(plan.outputRoot, `hikvision_${id}`), cacheDir: path.join(plan.cacheRoot, id),
        clips: plan.clips.map(c => ({ ...c, status: 'pending' })) };
      await save(job); jobs.set(id, job); await start(job, auth); return send(200, summary(job));
    }
    const match = /^\/api\/jobs\/([\da-f-]+)(?:\/(cancel|retry|verify))?$/.exec(req.url);
    if (match) {
      const job = jobs.get(match[1]); if (!job) return send(404, { error: '任务不存在' });
      if (req.method === 'GET' && !match[2]) return send(200, job);
      if (req.method === 'POST' && match[2] === 'cancel') { if (active?.id === job.id) { await fs.writeFile(active.cancelPath, 'cancel'); active.controller.abort(); } return send(200, { ok: true }); }
      if (req.method === 'POST' && ['retry', 'verify'].includes(match[2])) { await start(job, match[2] === 'retry' ? credentials(body) : { username: '', password: '' }, match[2] === 'verify'); return send(200, { ok: true }); }
    }
    send(404, { error: '接口不存在' });
  } catch (e) { send(400, { error: safeError(e) }); }
  finally { if (mutationHeld) mutationBusy = false; }
});
server.listen(Number(process.env.HIK_PORT || 0), '127.0.0.1', async () => {
  origin = `http://127.0.0.1:${server.address().port}`;
  await fs.writeFile(path.join(DATA, 'url.txt'), origin);
  console.log(`HIK_URL=${origin}`);
  if (process.argv.includes('--open')) await run('powershell.exe', ['-NoProfile', '-Command', `Start-Process '${origin}'`], { timeout: 15000 }).catch(() => {});
});
process.on('SIGINT', async () => { if (active) { await fs.writeFile(active.cancelPath, 'cancel'); active.controller.abort(); } else server.close(() => process.exit(0)); });
