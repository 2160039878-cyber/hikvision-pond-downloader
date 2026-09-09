import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { defaultConfig, validateConfig, makePlan, recoverJob, tolerance, wallTime, byteRange } from './core.mjs';
import { run, hash, verify, deliver, transcode } from './media.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const sample = { pools: ['2-1'], mode: 'range', start: '2026-01-31T23:30', end: '2026-02-01T01:00', outputRoot: 'D:\\录像 测试', cacheRoot: 'D:\\缓存' };
async function removeTestDirectory(dir) {
  assert.ok(path.resolve(dir).startsWith(path.join(path.resolve(os.tmpdir()), 'hik-')));
  await fs.rm(dir, { recursive: true, force: true });
}
test('跨日跨月拆段、去重、动态时长、映射约束', () => {
  const c = defaultConfig();
  assert.ok(Object.values(c.channels).every(v => v === null));
  assert.throws(() => makePlan(sample, c), /尚未绑定/);
  c.channels['2-1'] = 1; c.channels['2-8'] = 2;
  const p = makePlan(sample, c); assert.deepEqual(p.clips.map(c => c.seconds), [3600, 1800]);
  assert.equal(p.clips[1].start, '2026-02-01T00:30:00');
  assert.notEqual(p.clips[0].filename, p.clips[1].filename);
  const d = makePlan({ ...sample, mode: 'daily', startDate: '2026-01-31', endDate: '2026-02-01', times: ['23:59', '23:59'], minutes: 2, pools: ['2-1', '2-1', '2-8'] }, c);
  assert.equal(d.clips.length, 4); assert.equal(d.clips[0].end, '2026-02-01T00:01:00');
  assert.equal(makePlan(sample, c).fingerprint, p.fingerprint);
  assert.equal(p.clips[0].channel, 1);
  c.channels['1-1'] = null;
  assert.throws(() => makePlan({ ...sample, pools: ['1-1'] }, c), /尚未绑定/);
  assert.throws(() => wallTime('2026-02-30T00:00'), /无效/);
  assert.throws(() => makePlan({ ...sample, end: sample.start }, c), /结束/);
  assert.throws(() => makePlan({ ...sample, outputRoot: '..\\escape' }, c), /绝对/);
  c.channels['1-1'] = 1; assert.throws(() => validateConfig(c), /重复/);
  assert.deepEqual([tolerance(10), tolerance(120), tolerance(600)], [1, 2.4, 10]);
  assert.equal(recoverJob({ status: 'running', clips: [{ status: 'downloading' }, { status: 'complete' }] }).status, 'interrupted');
});

test('真实 FFmpeg 快速校验、损坏检测、复制哈希、中文路径与非覆盖', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'hik-media-test-'));
  try {
    const source = path.join(temp, 'source.mp4');
    const generated = await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=10', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source]);
    assert.equal(generated.code, 0, generated.stderr);
    const result = await verify(source, 3); assert.equal(result.videoCodec, 'h264');
    await assert.rejects(verify(source, 20), /时长不符/);
    const broken = path.join(temp, 'broken.mp4'); await fs.writeFile(broken, 'not a video');
    await assert.rejects(verify(broken, 3));
    const target = path.join(temp, '中文 文件夹', '录像.mp4');
    const copied = await deliver(source, target, 3); assert.equal(copied.sha256, await hash(source));
    assert.equal((await deliver(source, target, 3)).sha256, copied.sha256);
    await assert.rejects(deliver(source, target, 3, undefined, '0'.repeat(64)), /哈希/);
    assert.equal(await hash(target), copied.sha256);
    await assert.rejects(deliver(source, path.join(temp, 'mismatch.mp4'), 3, undefined, '0'.repeat(64)), /SHA256/);
    const abort = new AbortController(); abort.abort(); await assert.rejects(hash(source, abort.signal), /取消/);
    await assert.rejects(transcode(broken, path.join(temp, 'bad-output.mp4'), 3), /转码均失败/);
    const raw = path.join(temp, 'raw.ps');
    const ps = await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=10', '-t', '3', '-c:v', 'mpeg2video', '-f', 'mpeg', raw]);
    assert.equal(ps.code, 0);
    const encoders = [];
    const converted = await transcode(raw, path.join(temp, 'converted.mp4'), 3, undefined, { run: async (exe, args, opts) => {
      encoders.push(args[args.indexOf('-c:v') + 1]);
      return args.includes('h264_qsv') ? { code: 1, stderr: 'simulated unavailable hardware' } : run(exe, args, opts);
    } });
    assert.equal(converted.videoCodec, 'h264');
    assert.deepEqual(encoders, ['h264_qsv', 'libx264']);
  } finally { await removeTestDirectory(temp); }
});

test('外部进程超时与取消能够终止等待', async () => {
  await assert.rejects(run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 100 }), /超时/);
  const controller = new AbortController();
  const pending = run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(pending, /取消/);
});

test('视频分段请求边界与页面脚本语法', async () => {
  assert.deepEqual(byteRange('bytes=2-5', 10), { start: 2, end: 5 });
  assert.deepEqual(byteRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.deepEqual(byteRange('bytes=8-', 10), { start: 8, end: 9 });
  assert.throws(() => byteRange('bytes=10-', 10));
  assert.throws(() => byteRange('bytes=0-2,4-5', 10));
  const html = await fs.readFile(path.join(root, 'index.html'), 'utf8');
  new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
});

test('后台 API：来源限制、令牌、预览、重启恢复与凭据不落盘', async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'hik-api-test-'));
  const id = '11111111-1111-4111-8111-111111111111';
  await fs.mkdir(path.join(data, 'jobs'));
  const fixtureConfig = defaultConfig(); fixtureConfig.channels['2-1'] = 1;
  await fs.writeFile(path.join(data, 'config.json'), JSON.stringify(fixtureConfig));
  const mediaId = '22222222-2222-4222-8222-222222222222';
  await fs.mkdir(path.join(data, '中文 目录'));
  await fs.writeFile(path.join(data, 'transport-fixture.mp4'), '0123456789');
  await fs.writeFile(path.join(data, 'jobs', `${mediaId}.json`), JSON.stringify({ id: mediaId, status: 'complete', outputDir: data, createdAt: new Date().toISOString(), clips: [{ status: 'complete', filename: 'transport-fixture.mp4' }] }));
  await fs.writeFile(path.join(data, 'jobs', `${id}.json`), JSON.stringify({ id, status: 'running', createdAt: new Date().toISOString(), clips: [{ status: 'downloading' }] }));
  const child = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, HIK_DATA_DIR: data }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('server startup timeout')), 15000); let text = '';
      child.stdout.on('data', b => { text += b; const m = /HIK_URL=(http:\/\/127\.0\.0\.1:\d+)/.exec(text); if (m) { clearTimeout(timer); resolve(m[1]); } });
      child.on('exit', c => { clearTimeout(timer); reject(Error(`server exited ${c}`)); });
    });
    const html = await (await fetch(url)).text(); const token = /const TOKEN='([^']+)'/.exec(html)[1];
    assert.equal((await fetch(url + '/api/config')).status, 403);
    assert.equal((await fetch(url + '/api/config', { headers: { 'X-Session-Token': token, Origin: 'https://evil.invalid' } })).status, 403);
    const headers = { 'X-Session-Token': token, 'Content-Type': 'application/json' };
    const folders = await fetch(url + '/api/directories', { method: 'POST', headers, body: JSON.stringify({ path: data }) });
    assert.equal(folders.status, 200); assert.ok((await folders.json()).directories.some(d => d.name === '中文 目录'));
    assert.equal((await fetch(url + '/api/directories', { method: 'POST', headers, body: JSON.stringify({ path: '../' }) })).status, 400);
    const mediaUrl = url + `/media/${mediaId}/0`;
    assert.equal((await fetch(mediaUrl)).status, 403);
    const stream = await fetch(mediaUrl, { headers: { Cookie: `hik_session=${token}`, Range: 'bytes=2-5' } });
    assert.equal(stream.status, 206); assert.equal(await stream.text(), '2345');
    assert.equal((await fetch(mediaUrl, { headers: { Cookie: `hik_session=${token}`, Range: 'bytes=99-' } })).status, 416);
    const preview = await fetch(url + '/api/preview', { method: 'POST', headers, body: JSON.stringify(sample) }); assert.equal(preview.status, 200);
    assert.equal((await preview.json()).clips.length, 2);
    const job = await (await fetch(url + `/api/jobs/${id}`, { headers })).json(); assert.equal(job.status, 'interrupted');
    const response = await fetch(url + '/api/jobs', { method: 'POST', headers, body: JSON.stringify({ ...sample, username: 'sentinel-user', password: 'sentinel-password', expectedFingerprint: 'wrong' }) });
    assert.equal(response.status, 400);
    for (const file of await fs.readdir(path.join(data, 'jobs'))) assert.ok(!(await fs.readFile(path.join(data, 'jobs', file), 'utf8')).includes('sentinel-password'));
  } finally {
    child.kill(); await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve));
    await removeTestDirectory(data);
  }
});
