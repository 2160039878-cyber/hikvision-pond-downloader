import path from 'node:path';
import crypto from 'node:crypto';

export const pools = [1, 2].flatMap(area => Array.from({ length: 8 }, (_, i) => `${area}-${i + 1}`));
export function defaultConfig() {
  return { deviceIp: '192.0.2.1', sdkPort: 8000,
    sdkDir: 'C:\\Program Files (x86)\\iVMS-4200 Site\\iVMS-4200 Client\\Client',
    // Configure actual channels locally; no site mapping is distributed.
    channels: Object.fromEntries(pools.map(pool => [pool, null])) };
}
export function validateConfig(value) {
  if (!value || !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value.deviceIp) || value.deviceIp.split('.').some(n => Number(n) > 255)) throw Error('设备地址必须是有效 IPv4 地址');
  if (!Number.isInteger(value.sdkPort) || value.sdkPort < 1 || value.sdkPort > 65535) throw Error('SDK 端口无效');
  if (!path.win32.isAbsolute(value.sdkDir) || value.sdkDir.includes('\0')) throw Error('SDK 目录必须是绝对路径');
  const channels = {}, used = new Set();
  for (const p of pools) {
    const n = value.channels?.[p] ?? null;
    if (n !== null && (!Number.isInteger(n) || n < 1 || n > 4096 || used.has(n))) throw Error(`鱼池 ${p} 的通道无效或重复`);
    channels[p] = n; if (n !== null) used.add(n);
  }
  return { deviceIp: value.deviceIp, sdkPort: value.sdkPort, sdkDir: value.sdkDir, channels };
}
// Device wall-clock fields are encoded as UTC solely for arithmetic, never converted to browser UTC.
export function wallTime(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(s)) throw Error('日期时间格式无效');
  const full = s.length === 16 ? `${s}:00` : s;
  const n = Date.parse(`${full}Z`);
  if (!Number.isFinite(n) || new Date(n).toISOString().slice(0, 19) !== full || Number(s.slice(0, 4)) < 2000) throw Error('日期时间无效');
  return n;
}
const wall = n => new Date(n).toISOString().slice(0, 19);
export const tolerance = seconds => Math.max(1, Math.min(10, seconds * 0.02));
export function absoluteFolder(s) {
  if (typeof s !== 'string' || !path.win32.isAbsolute(s) || /[\0\r\n*?"<>|]/.test(s) || s.startsWith('\\\\?') || s.startsWith('\\\\.')) throw Error('请选择有效的绝对文件夹路径');
  return path.win32.normalize(s);
}
export function byteRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || (!m[1] && !m[2])) throw Error('无效的视频范围');
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) throw Error('视频范围越界');
  return { start, end };
}
export function makePlan(input, config) {
  if (!input || !Array.isArray(input.pools) || !input.pools.length) throw Error('至少选择一个鱼池');
  const selected = [...new Set(input.pools)].sort();
  for (const p of selected) if (!pools.includes(p) || !config.channels[p]) throw Error(`鱼池 ${p} 尚未绑定有效通道`);
  const spans = [], seen = new Set();
  const add = (s, e) => {
    if (e <= s) throw Error('结束时间必须晚于开始时间');
    for (let t = s; t < e; t += 3600000) {
      const end = Math.min(e, t + 3600000), key = `${t}/${end}`;
      if (!seen.has(key)) { spans.push([t, end]); seen.add(key); }
      if (spans.length * selected.length > 10000) throw Error('一次最多 10000 个片段，请缩小时间范围');
    }
  };
  if (input.mode === 'range') add(wallTime(input.start), wallTime(input.end));
  else if (input.mode === 'daily') {
    const s = wallTime(`${input.startDate}T00:00`), e = wallTime(`${input.endDate}T00:00`);
    if (e < s || e - s > 366 * 86400000) throw Error('日期范围无效或超过 366 天');
    if (!Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > 1440) throw Error('每段时长必须是 1～1440 分钟的整数');
    if (!Array.isArray(input.times) || !input.times.length || input.times.length > 96) throw Error('每日时间点必须为 1～96 个');
    for (const time of input.times) if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw Error('每日时间点格式应为 HH:mm');
    for (let day = s; day <= e; day += 86400000) for (const time of input.times) {
      const start = wallTime(`${wall(day).slice(0, 10)}T${time}`); add(start, start + input.minutes * 60000);
    }
  } else throw Error('时间模式无效');
  spans.sort((a, b) => a[0] - b[0]);
  const compact = s => s.replaceAll('-', '').replaceAll(':', '').replace('T', '_');
  const clips = selected.flatMap(pool => spans.map(([s, e]) => {
    const start = wall(s), end = wall(e), channel = config.channels[pool];
    return { pool, channel, start, end, seconds: (e - s) / 1000,
      filename: `pool${pool}_${compact(start)}_${compact(end)}_ch${channel}.mp4` };
  }));
  const plan = { deviceIp: config.deviceIp, sdkPort: config.sdkPort, sdkDir: config.sdkDir,
    outputRoot: absoluteFolder(input.outputRoot), cacheRoot: absoluteFolder(input.cacheRoot), clips };
  plan.fingerprint = crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex');
  return plan;
}
export function recoverJob(job) {
  if (['running', 'queued', 'verifying'].includes(job.status)) job.status = 'interrupted';
  for (const c of job.clips) if (!['complete', 'failed', 'cancelled', 'pending'].includes(c.status)) c.status = 'interrupted';
  return job;
}
