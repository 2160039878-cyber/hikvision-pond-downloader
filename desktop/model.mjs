import crypto from 'node:crypto';
import { wallTime, makePlan } from '../core.mjs';
export const terminal = new Set(['complete', 'failed', 'cancelled', 'no_recording']);
export const uuid = () => crypto.randomUUID();
export function deviceInput(v) {
  if (!v || typeof v.name !== 'string' || !v.name.trim() || v.name.length > 80) throw Error('请填写 1～80 字的设备名称');
  if (typeof v.host !== 'string' || !/^[a-zA-Z0-9.-]{1,253}$/.test(v.host) || v.host.startsWith('-')) throw Error('请输入有效的 IPv4 地址或主机名');
  if (/^[\d.]+$/.test(v.host) && (!/^(\d{1,3}\.){3}\d{1,3}$/.test(v.host) || v.host.split('.').some(n => +n > 255))) throw Error('IPv4 地址无效');
  if (!Number.isInteger(v.port) || v.port < 1 || v.port > 65535) throw Error('设备端口无效');
  if (typeof v.username !== 'string' || !v.username || v.username.length > 128) throw Error('请输入设备用户名');
  if (v.password !== undefined && (typeof v.password !== 'string' || v.password.length > 256)) throw Error('密码格式无效');
  return { name: v.name.trim(), host: v.host.toLowerCase(), port: v.port, username: v.username, remember: v.remember === true };
}
export function cameraInput(v) {
  if (!Number.isInteger(v.channel) || v.channel < 1 || v.channel > 4096) throw Error('通道必须是 1～4096 的整数');
  if (typeof v.name !== 'string' || !v.name.trim() || v.name.length > 100) throw Error('摄像头名称无效');
  return { channel: v.channel, name: v.name.trim(), online: null, manual: true };
}
export function plan(input, devices) {
  if (!Array.isArray(input?.cameras) || !input.cameras.length || input.cameras.length > 4096) throw Error('请选择摄像头');
  const selected = [...new Set(input.cameras)].sort();
  const clips = [];
  for (const key of selected) {
    const d = devices.find(d => d.cameras.some(c => `${d.id}:${c.channel}` === key));
    const c = d?.cameras.find(c => `${d.id}:${c.channel}` === key);
    if (!d || !c) throw Error('摄像头配置已改变，请重新选择');
    // Reuse the tested wall-clock splitter, with one synthetic key per actual camera.
    const p = makePlan({ ...input, pools: ['1-1'] }, { deviceIp: d.host, sdkPort: d.port, sdkDir: 'C:\\unused', channels: { '1-1': c.channel } });
    for (const span of p.clips) {
      const stamp = s => s.replaceAll('-', '').replaceAll(':', '').replace('T', '_');
      clips.push({ id: uuid(), deviceId: d.id, deviceName: d.name, host: d.host, port: d.port, username: d.username,
        channel: c.channel, cameraName: c.name, start: span.start, end: span.end, seconds: span.seconds,
        filename: `device_${d.id}_ch${c.channel}_${stamp(span.start)}_${stamp(span.end)}.mp4`, status: 'pending', recording: 'unchecked' });
    }
    if (clips.length > 10000) throw Error('一次最多 10000 个片段');
  }
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ output: input.outputRoot, cache: input.cacheRoot, clips: clips.map(({ id, ...c }) => c) })).digest('hex');
  return { clips, outputRoot: input.outputRoot, cacheRoot: input.cacheRoot, fingerprint };
}
export function coverage(start, end, intervals) {
  const s = wallTime(start), e = wallTime(end);
  const spans = intervals.map(v => [Math.max(s, wallTime(v.start)), Math.min(e, wallTime(v.end))]).filter(([a,b]) => b > a).sort((a,b) => a[0]-b[0]);
  if (!spans.length) return 'none';
  let cursor = s;
  for (const [a,b] of spans) { if (a > cursor) return 'partial'; cursor = Math.max(cursor,b); if (cursor >= e) return 'full'; }
  return 'partial';
}
export function recover(state) {
  for (const j of state.jobs) {
    if (['queued','running','verifying'].includes(j.status)) j.status = 'interrupted';
    for (const c of j.clips) if (!terminal.has(c.status)) c.status = 'interrupted';
  }
  return state;
}
export function diagnostic(state, environment) {
  return { version: 2, release: 'preview', environment: { sdk: !!environment.sdkDir, ffmpeg: !!environment.ffmpeg, ffprobe: !!environment.ffprobe },
    devices: state.devices.map((d,i) => ({ label: `设备 ${i+1}`, cameras: d.cameras.length, manual: d.cameras.filter(c=>c.manual).length })),
    jobs: state.jobs.map(j => ({ status: j.status, clips: j.clips.map(c=>({ status:c.status, recording:c.recording, attempt:c.attempt || 0, sdkCode:c.sdkCode || null })) })) };
}
