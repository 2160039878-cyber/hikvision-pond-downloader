import fs from 'node:fs/promises';
import path from 'node:path';
import { plan, deviceInput, cameraInput, coverage, recover, diagnostic, uuid, terminal } from './model.mjs';
import { absoluteFolder } from '../core.mjs';
import { hash, verify, transcode, deliver } from '../media.mjs';
const clone=v=>structuredClone(v);
export class Service {
  constructor({dataDir,adapter,vault,env}){
    Object.assign(this,{dataDir,adapter,vault,env});this.auth=new Map();this.blockedAuth=new Map();this.previews=new Map();this.active=null;this.probing=null;this.stopping=false;this.write=Promise.resolve();
  }
  async init(){
    await fs.mkdir(this.dataDir,{recursive:true});
    try{this.state=JSON.parse(await fs.readFile(path.join(this.dataDir,'state.json'),'utf8'));if(this.state.version!==2)throw Error('数据版本不兼容');recover(this.state)}
    catch(e){if(e.code!=='ENOENT')throw Error('本地数据无法读取，请保留文件后恢复备份');this.state={version:2,devices:[],jobs:[],settings:{outputRoot:'',cacheRoot:path.join(this.dataDir,'cache')}}}
    if(this.state.settings.sdkDir)this.env.sdkDir=this.state.settings.sdkDir;
    await this.save();return this;
  }
  save(){const data=JSON.stringify(this.state,null,2);this.write=this.write.catch(()=>{}).then(async()=>{const target=path.join(this.dataDir,'state.json'),tmp=target+'.tmp';await fs.writeFile(tmp,data);await fs.rename(tmp,target)});return this.write}
  snapshot(){return clone({...this.state,environment:{...this.env,preview:true},active:this.active?.job.id||null,probing:!!this.probing,queryProgress:this.probing?.progress||null})}
  async password(device){const key=device.id;if(this.blockedAuth.has(key))throw this.blockedAuth.get(key);let value=this.auth.get(key);if(!value && device.remember){try{value=await this.vault.get(key)}catch{throw Error(`设备“${device.name}”的密码无法解密，请重新输入`)}}if(!value)throw Error(`请为设备“${device.name}”输入密码`);return value}
  mutableDevice(id){if(this.state.jobs.some(j=>j.clips.some(c=>c.deviceId===id&&!terminal.has(c.status))))throw Error('设备仍有未完成任务，请先取消相关任务')}
  async upsert(v){
    if(this.probing)throw Error('请等待设备查询结束后修改配置');
    const input=deviceInput(v),existing=v.id?this.state.devices.find(d=>d.id===v.id):null;
    if(v.id&&!existing)throw Error('设备不存在');
    if(existing)this.mutableDevice(existing.id);
    if(this.state.devices.some(d=>d.id!==existing?.id&&d.host===input.host&&d.port===input.port))throw Error('该设备地址和端口已经添加');
    const d={...input,id:existing?.id||uuid(),cameras:existing?.cameras||[]};
    const identityChanged=existing && ['host','port','username'].some(k=>d[k]!==existing[k]);
    if(identityChanged&&!v.password)throw Error('更换设备地址、端口或用户名时，请重新输入密码');
    if(identityChanged){d.cameras=[];this.auth.delete(d.id);await this.vault.remove(d.id)}
    if(v.password){this.auth.set(d.id,v.password);this.blockedAuth.delete(d.id);if(d.remember)await this.vault.set(d.id,v.password)}
    else if(d.remember&&!existing?.remember){const password=this.auth.get(d.id);if(!password)throw Error('记住密码前请先输入密码');await this.vault.set(d.id,password)}
    if(!d.remember)await this.vault.remove(d.id);
    if(existing)this.state.devices.splice(this.state.devices.indexOf(existing),1,d);else this.state.devices.push(d);
    this.previews.clear();await this.save();return d.id;
  }
  async forget(id){const d=this.device(id);d.remember=false;this.auth.delete(id);this.blockedAuth.delete(id);await this.vault.remove(id);await this.save()}
  async supply({id,password,remember}){const d=this.device(id);if(typeof password!=='string'||!password||password.length>256)throw Error('请输入有效密码');this.auth.set(id,password);this.blockedAuth.delete(id);d.remember=remember===true;if(d.remember)await this.vault.set(id,password);else await this.vault.remove(id);await this.save()}
  device(id){const d=this.state.devices.find(d=>d.id===id);if(!d)throw Error('设备不存在');return d}
  async remove(id){this.mutableDevice(id);await this.forget(id);this.state.devices=this.state.devices.filter(d=>d.id!==id);this.previews.clear();await this.save()}
  async settings(v){
    if(this.active||this.probing)throw Error('请等待当前操作结束后修改设置');
    for(const key of ['outputRoot','cacheRoot'])if(v[key]!==undefined)this.state.settings[key]=absoluteFolder(v[key]);
    await this.save();this.previews.clear();return this.snapshot();
  }
  async probe(fn){if(this.probing)throw Error('已有设备查询正在执行');const ctx={controller:new AbortController(),cancelPath:path.join(this.dataDir,`probe-${uuid()}`)};this.probing=ctx;try{return await fn(ctx)}finally{await fs.unlink(ctx.cancelPath).catch(()=>{});this.probing=null}}
  async cancelProbe(){this.probing?.controller.abort()}
  async discover(id){return this.probe(async ctx=>{const d=this.device(id),password=await this.password(d);const r=await this.adapter.call('discover',d,password,{cancelPath:ctx.cancelPath},ctx.controller.signal);if(!Array.isArray(r.cameras)||!r.cameras.length)throw Error('设备没有返回可用通道，可在高级设置中手动添加');d.cameras=r.cameras.map(c=>({...cameraInput(c),...c,name:d.cameras.find(old=>old.channel===c.channel)?.name||c.name,manual:false}));d.capabilities={discovery:r.discovery,deviceType:r.deviceType};this.previews.clear();await this.save();return clone(d)})}
  async camera({deviceId,channel,name}){const d=this.device(deviceId),c=cameraInput({channel,name}),existing=d.cameras.find(c=>c.channel===channel);if(existing)existing.name=c.name;else d.cameras.push(c);this.previews.clear();await this.save()}
  async preview(input){return this.probe(async ctx=>{
    const p=plan({...input,cacheRoot:this.state.settings.cacheRoot},this.state.devices),blocked=new Map();
    ctx.progress={current:0,total:p.clips.length};
    for(const c of p.clips){
      ctx.progress.current++;
      if(ctx.controller.signal.aborted)throw Error('查询已取消');
      if(blocked.has(c.deviceId)){c.recording='unknown';c.queryError=blocked.get(c.deviceId);continue}
      const d=this.device(c.deviceId);
      try{const r=await this.adapter.call('query',d,await this.password(d),{channel:c.channel,start:c.start,end:c.end,cancelPath:ctx.cancelPath},ctx.controller.signal);c.recording=coverage(c.start,c.end,r.intervals)}
      catch(e){if(ctx.controller.signal.aborted)throw Error('查询已取消');c.recording='unknown';c.queryError=e.message;if(e.auth){this.blockedAuth.set(c.deviceId,e);blocked.set(c.deviceId,e.message);c.sdkCode=e.sdkCode}}
    }
    p.id=uuid();p.created=Date.now();this.previews.clear();this.previews.set(p.id,p);return clone(p);
  })}
  async submit({previewId,allowUnknown=false}){
    if(this.stopping)throw Error('程序正在退出');const p=this.previews.get(previewId);
    if(!p||Date.now()-p.created>30*60000)throw Error('预览已过期，请重新查询');
    if(p.clips.some(c=>c.recording==='unknown')&&!allowUnknown)throw Error('部分录像查询失败，请勾选确认后再提交');
    const duplicate=this.state.jobs.find(j=>j.fingerprint===p.fingerprint&&['queued','running','verifying','complete'].includes(j.status));if(duplicate)return {id:duplicate.id,duplicate:true};
    const j={...clone(p),id:uuid(),createdAt:new Date().toISOString(),status:'queued'};delete j.created;
    j.outputDir=path.join(absoluteFolder(p.outputRoot),`recordings_${j.id}`);j.cacheDir=path.join(absoluteFolder(p.cacheRoot),j.id);
    for(const c of j.clips){c.status=c.recording==='none'?'no_recording':'pending';delete c.queryError}
    this.state.jobs.push(j);await this.save();this.previews.delete(previewId);this.kick();return {id:j.id};
  }
  job(id){const j=this.state.jobs.find(j=>j.id===id);if(!j)throw Error('任务不存在');return j}
  kick(){if(this.active||this.stopping)return;const job=this.state.jobs.find(j=>j.status==='queued');if(!job)return;const ctx={job,controller:new AbortController(),cancelPath:path.join(this.dataDir,`cancel-${job.id}`)};this.active=ctx;this.running=this.execute(ctx).finally(()=>{this.active=null;this.kick()})}
  async space(dir){await fs.mkdir(dir,{recursive:true});const stats=await fs.statfs(dir);if(stats.bavail*stats.bsize<64*1024*1024)throw Error('磁盘空间不足 64 MB，请更换目录或释放空间')}
  async reports(j){
    const report={version:2,id:j.id,status:j.status,check:'快速校验：容器、编码、时长、首帧及复制 SHA256；不代表全片无损坏',clips:j.clips.map(({host,username,...c})=>c)};
    const file=path.join(j.outputDir,'任务清单.json');await fs.writeFile(file+'.tmp',JSON.stringify(report,null,2));await fs.rename(file+'.tmp',file);
    const cell=x=>'"'+String(x??'').replaceAll('"','""')+'"';
    const rows=[['设备','摄像头','开始','结束','状态','文件','SHA256','校验说明'],...j.clips.map(c=>[c.deviceName,c.cameraName,c.start,c.end,c.status,c.filename,c.sha256,c.validation?.check||c.error])];
    const csv=path.join(j.outputDir,'校验报告.csv');await fs.writeFile(csv+'.tmp','\ufeff'+rows.map(r=>r.map(cell).join(',')).join('\r\n'));await fs.rename(csv+'.tmp',csv);
  }
  async execute(ctx){
    const j=ctx.job,signal=ctx.controller.signal,blocked=new Map();j.status=j.verifyOnly?'verifying':'running';
    try{
      await this.save();await this.space(j.outputDir);if(!j.verifyOnly)await this.space(j.cacheDir);
      for(const c of j.clips){
        if(signal.aborted)break;if(c.status==='no_recording'||(!j.verifyOnly&&c.status==='complete'))continue;
        c.error='';const target=path.join(j.outputDir,c.filename),raw=path.join(j.cacheDir,c.filename+'.ps'),standard=raw+'.mp4';
        try{
          if(j.verifyOnly){if(!c.sha256)throw Error('缺少原始哈希基线');c.status='verifying';await this.save();const result=await verify(target,c.seconds,signal,this.env);if(await hash(target,signal)!==c.sha256)throw Error('目标文件 SHA256 不一致，未覆盖');c.validation={...result,size:(await fs.stat(target)).size};c.status='complete';await this.save();continue}
          if(blocked.has(c.deviceId)){c.status='waiting_credentials';c.error=blocked.get(c.deviceId);continue}
          const device={id:c.deviceId,name:c.deviceName,host:c.host,port:c.port,username:c.username,remember:this.device(c.deviceId).remember};
          let password;try{password=await this.password(device)}catch(e){blocked.set(c.deviceId,e.message);c.status='waiting_credentials';c.error=e.message;continue}
          for(let attempt=1;attempt<=3;attempt++){
            c.attempt=attempt;
            try{
              if(signal.aborted)throw Error('已取消');await this.space(j.cacheDir);await this.space(j.outputDir);
              if(c.sha256){try{c.validation=await verify(target,c.seconds,signal,this.env);if(await hash(target,signal)!==c.sha256)throw Error('已有文件 SHA256 不一致，未覆盖');c.status='complete';break}catch(e){if(e.code!=='ENOENT')throw e}}
              const cached=c.rawSha256&&await hash(raw,signal).catch(()=>'')===c.rawSha256;
              if(!cached){c.status='downloading';await this.save();await fs.unlink(raw).catch(()=>{});await this.adapter.call('download',device,password,{channel:c.channel,start:c.start,end:c.end,raw,cancelPath:ctx.cancelPath},signal,line=>{const m=/^PROGRESS:(\d+)$/.exec(line);if(m)c.progress=Math.min(100,+m[1])});c.rawSha256=await hash(raw,signal)}
              c.status='transcoding';await this.save();const conversion=await transcode(raw,standard,c.seconds,signal,this.env);
              c.status='verifying';await this.save();c.sha256=await hash(standard,signal);
              c.status='copying';await this.save();c.validation={...conversion,...await deliver(standard,target,c.seconds,signal,c.sha256,this.env)};
              c.status='complete';await this.save();await this.reports(j);
              for(const file of [raw,raw+'.partial',standard])await fs.unlink(file).catch(()=>{});break;
            }catch(e){
              if(e.auth){this.blockedAuth.set(c.deviceId,e);blocked.set(c.deviceId,e.message);c.sdkCode=e.sdkCode;throw e}
              if(/时长|转码|结构/.test(e.message))c.rawSha256=null;
              if(signal.aborted||attempt===3||/SHA256|哈希|空间|路径|已有/.test(e.message))throw e;
              c.status='retrying';c.error=e.message;await this.save();await new Promise(resolve=>{const t=setTimeout(done,2000);function done(){clearTimeout(t);signal.removeEventListener('abort',done);resolve()}signal.addEventListener('abort',done,{once:true})});
            }
          }
        }catch(e){c.status=signal.aborted?'cancelled':e.auth?'waiting_credentials':'failed';c.error=e.message;c.sdkCode=e.sdkCode||null}
        await this.save();await this.reports(j);
        if(c.status==='complete')for(const file of [raw,raw+'.partial',standard])await fs.unlink(file).catch(()=>{});
      }
      if(signal.aborted){for(const c of j.clips)if(!terminal.has(c.status))c.status='cancelled';j.status='cancelled'}
      else j.status=j.clips.every(c=>c.status==='complete')?'complete':j.clips.some(c=>c.status==='waiting_credentials')?'waiting_credentials':'partial';
      await this.reports(j);
    }catch(e){j.status=signal.aborted?'cancelled':'failed';j.error=e.message}
    finally{delete j.verifyOnly;await this.save();await fs.unlink(ctx.cancelPath).catch(()=>{})}
  }
  async cancel(id){const j=this.job(id);if(this.active?.job.id===id){this.active.controller.abort();return}for(const c of j.clips)if(!terminal.has(c.status))c.status='cancelled';j.status='cancelled';await this.save()}
  async retry(id,verifyOnly=false){const j=this.job(id);if(['queued','running','verifying'].includes(j.status))throw Error('任务正在排队或执行');j.error='';j.verifyOnly=verifyOnly;j.status='queued';if(!verifyOnly)for(const c of j.clips)if(!['complete','no_recording'].includes(c.status))c.status='pending';await this.save();this.kick()}
  async shutdown(){this.stopping=true;await this.cancelProbe();this.active?.controller.abort();if(this.running)await this.running;while(this.probing)await new Promise(r=>setTimeout(r,100));await this.save();this.auth.clear()}
  diagnostics(){return diagnostic(this.state,this.env)}
  media(id,index){const j=this.job(id),c=j.clips[index];if(!c||c.status!=='complete')throw Error('录像尚未校验完成');if(path.basename(c.filename)!==c.filename)throw Error('无效文件');return path.join(j.outputDir,c.filename)}
}
