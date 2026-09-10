import fs from 'node:fs/promises';
import path from 'node:path';
import dns from 'node:dns/promises';
import { fileURLToPath } from 'node:url';
import { run } from '../media.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
export function sdkError(code) {
  const messages={1:'用户名或密码错误，请更正后重试',2:'账号缺少操作权限，请联系设备管理员',7:'无法连接设备，请检查地址和网络',10:'设备响应超时',17:'设备接口参数不兼容',23:'设备不支持该接口',34:'无法创建缓存文件，请更换缓存位置',153:'账号已锁定，请等待设备解除锁定'};
  const error=Error(messages[code] || `设备操作失败（SDK ${code || '未知'}）`); error.sdkCode=Number(code); error.auth=[1,2,153].includes(Number(code)); return error;
}
export async function environment(resources) {
  const dirs=[path.join(resources,'sdk'),path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)','iVMS-4200 Site','iVMS-4200 Client','Client')];
  let sdkDir=null;
  for(const dir of dirs){try {const dll=await fs.readFile(path.join(dir,'HCNetSDK.dll')); if(dll.readUInt16LE(dll.readUInt32LE(60)+4)===0x8664){sdkDir=dir;break}}catch{}}
  const result={sdkDir,ffmpeg:null,ffprobe:null};
  for(const name of ['ffmpeg','ffprobe']){
    for(const exe of [path.join(resources,'bin',`${name}.exe`),name]){try {if((await run(exe,['-version'],{timeout:10000})).code===0){result[name]=exe;break}}catch{}}
  }
  return result;
}
export class Adapter {
  constructor(env){this.env=env;this.operations=new Set()}
  async call(operation,device,password,extra={},signal,onLine){
    if(!this.env.sdkDir)throw Error('未检测到海康 SDK。当前为预览版，请在设置中选择已合法获取的 SDK 目录');
    const resolved=(await dns.lookup(device.host,{family:4})).address;
    const cancelPath=extra.cancelPath;
    const cancel=()=>{if(cancelPath)void fs.writeFile(cancelPath,'cancel')};
    if(signal?.aborted)throw Error('已取消');
    signal?.addEventListener('abort',cancel,{once:true});
    const common={host:resolved,port:device.port,username:device.username,password,sdkDir:this.env.sdkDir,cancelPath};
    const download=operation==='download';
    const input=(download ? [resolved,device.port,this.env.sdkDir,device.username,password,extra.channel,extra.start,extra.end,extra.raw,cancelPath] : [resolved,device.port,device.username,password,this.env.sdkDir,cancelPath,operation,extra.channel||'',extra.start||'',extra.end||'']).map(s=>Buffer.from(String(s)).toString('base64')).join('\n')+'\n';
    try {
      const r=await run('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',download?path.join(root,'..','download-worker.ps1'):path.join(root,'probe-worker.ps1')],{input,onLine,timeout:download?3660000:180000});
      if(signal?.aborted)throw Error('已取消');
      if(download){const m=/RESULT:([^\r\n]+)/.exec(r.stdout)?.[1];if(r.code!==0 || !m?.startsWith('ok:'))throw sdkError(m?.split(':')[1]); return {};}
      if(r.code!==0){const e=sdkError(/ERROR:(\d+)/.exec(r.stdout)?.[1]);e.message+=' '+(/DIAGNOSTIC:[^\r\n]+/.exec(r.stdout)?.[0]||'');throw e}
      if(!/^OK\r?$/m.test(r.stdout))throw Error('设备查询未返回有效数据');
      if(operation==='discover')return {deviceType:Number(/META:(\d+)/.exec(r.stdout)?.[1]),discovery:/META:\d+:1/.test(r.stdout)?'sdk-ipparacfg-v40':'sdk-login-channel-range',cameras:[...r.stdout.matchAll(/^CAMERA:(\d+):([^:]*):(\d):(-?\d+)/gm)].map(m=>({channel:+m[1],name:Buffer.from(m[2],'base64').toString('utf8'),nameRead:m[3]==='1',online:+m[4]<0?null:m[4]==='1',manual:false}))};
      return {intervals:[...r.stdout.matchAll(/^INTERVAL:([^|]+)\|([^\r\n]+)/gm)].map(m=>({start:m[1],end:m[2]}))};
    } finally {signal?.removeEventListener('abort',cancel)}
  }
}
