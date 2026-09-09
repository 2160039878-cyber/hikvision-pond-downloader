import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { tolerance } from './core.mjs';

export function run(exe, args, { signal, timeout = 900000, input, onLine } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Error('已取消'));
    const child = spawn(exe, args, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', lines = '', reason = '';
    const timer = setTimeout(() => { reason = '执行超时'; child.kill(); }, timeout);
    const abort = () => { reason = '已取消'; child.kill(); };
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', b => {
      const t = b.toString(); stdout = (stdout + t).slice(-1500000); lines += t;
      const parts = lines.split(/\r?\n/); lines = parts.pop(); for (const line of parts) onLine?.(line);
    });
    child.stderr.on('data', b => { stderr = (stderr + b.toString()).slice(-8000); });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    child.on('error', e => { cleanup(); reject(e); });
    child.on('close', code => { cleanup(); reason ? reject(Error(reason)) : resolve({ code, stdout, stderr }); });
  });
}
export async function hash(file, signal) {
  const h = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) { if (signal?.aborted) throw Error('已取消'); h.update(chunk); }
  return h.digest('hex');
}
export async function verify(file, seconds, signal, executables = {}) {
  if ((await fs.stat(file)).size === 0) throw Error('视频文件为空');
  const probe = await run(executables.ffprobe || 'ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file], { signal, timeout: 60000 });
  if (probe.code !== 0) throw Error('无法读取视频结构');
  const info = JSON.parse(probe.stdout), video = info.streams?.find(s => s.codec_type === 'video');
  const audio = info.streams?.filter(s => s.codec_type === 'audio') || [];
  const duration = Number(info.format?.duration);
  if (!info.format?.format_name?.split(',').some(n => ['mp4', 'mov'].includes(n))) throw Error('不是标准 MP4 容器');
  if (video?.codec_name !== 'h264') throw Error('视频不是 H.264 编码');
  if (audio.some(s => s.codec_name !== 'aac')) throw Error('音频不是 AAC 编码');
  if (!Number.isFinite(duration) || Math.abs(duration - seconds) > tolerance(seconds)) throw Error(`时长不符：要求 ${seconds} 秒，实际 ${duration} 秒`);
  const decode = await run(executables.ffmpeg || 'ffmpeg', ['-v', 'error', '-xerror', '-i', file, '-map', '0:v:0', '-frames:v', '1', '-f', 'null', '-'], { signal, timeout: 60000 });
  if (decode.code !== 0 || decode.stderr.trim()) throw Error('首帧解码失败');
  return { duration, videoCodec: video.codec_name, audioCodec: audio.length ? 'aac' : 'none', check: '快速校验通过（未检查全片解码）' };
}
export async function transcode(source, destination, seconds, signal, executables = {}) {
  for (const encoder of ['h264_qsv', 'libx264']) {
    const args = ['-y', '-nostdin', '-v', 'error', '-f', 'mpeg', '-i', source, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', encoder,
      ...(encoder === 'h264_qsv' ? ['-global_quality', '28', '-pix_fmt', 'nv12'] : ['-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p']),
      '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', '-f', 'mp4', destination];
    const r = await (executables.run || run)(executables.ffmpeg || 'ffmpeg', args, { signal, timeout: Math.max(900000, seconds * 10000) });
    if (r.code === 0) { const result = await verify(destination, seconds, signal, executables); return { ...result, encoder }; }
    if (signal?.aborted) throw Error('已取消');
  }
  throw Error('硬件和软件转码均失败；原始文件已保留');
}
export async function deliver(source, target, seconds, signal, expectedHash, executables = {}) {
  const sourceHash = expectedHash || await hash(source, signal);
  try {
    await fs.access(target);
    const result = await verify(target, seconds, signal, executables);
    if (await hash(target, signal) !== sourceHash) throw Error('已有目标文件哈希不符；未覆盖，请更换输出目录或处理冲突文件');
    return { ...result, sha256: sourceHash, size: (await fs.stat(target)).size };
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const temp = `${target}.${crypto.randomUUID()}.copying`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await pipeline(createReadStream(source), createWriteStream(temp, { flags: 'wx' }), { signal });
    const handle = await fs.open(temp, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
    if ((await fs.stat(source)).size !== (await fs.stat(temp)).size || await hash(temp, signal) !== sourceHash) throw Error('复制后 SHA256 或大小不一致，目标盘可能异常');
    const result = await verify(temp, seconds, signal, executables);
    // Reserve the final name without overwriting existing user data. The empty placeholder is never complete.
    const reserve = await fs.open(target, 'wx'); await reserve.close();
    try { await fs.rename(temp, target); } catch (e) { await fs.unlink(target).catch(() => {}); throw e; }
    return { ...result, sha256: sourceHash, size: (await fs.stat(target)).size };
  } finally { await fs.unlink(temp).catch(() => {}); }
}
