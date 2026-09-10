import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import {deviceInput,plan,coverage,diagnostic,recover} from './model.mjs';
import {Service} from './service.mjs';
import {run} from '../media.mjs';
const input={name:'测试设备',host:'192.0.2.1',port:8000,username:'fixture',password:'test-only-secret',remember:false};
const request={mode:'range',start:'2026-01-31T23:59:00',end:'2026-02-01T00:00:00',outputRoot:'C:\\test',cacheRoot:'C:\\cache'};
async function temp(){return fs.mkdtemp(path.join(os.tmpdir(),'hik-v2-'))}
async function cleanup(dir){assert.ok(path.resolve(dir).startsWith(path.join(os.tmpdir(),'hik-v2-')));await fs.rm(dir,{recursive:true,force:true})}
async function idle(s){for(let i=0;i<300;i++){if(!s.active&&!s.state.jobs.some(j=>j.status==='queued'))return;await new Promise(r=>setTimeout(r,20))}throw Error('Queue timeout')}
const vault=()=>{const values=new Map();return {get:async id=>values.get(id),set:async(id,v)=>values.set(id,v),remove:async id=>values.delete(id)}};
test('通用设备、跨设备计划、时间与覆盖合并',()=>{
 assert.throws(()=>deviceInput({...input,host:'999.1.1.1'}));assert.throws(()=>deviceInput({...input,host:'http://host/path'}));
 const ds=[{...input,id:'device-a',cameras:[{channel:3,name:'同名'}]},{...input,id:'device-b',cameras:[{channel:3,name:'同名'}]}];
 const p=plan({...request,cameras:['device-a:3','device-b:3','device-a:3']},ds);assert.equal(p.clips.length,2);assert.notEqual(p.clips[0].filename,p.clips[1].filename);assert.equal(p.clips[0].seconds,60);
 assert.equal(coverage(request.start,request.end,[]),'none');
 assert.equal(coverage(request.start,request.end,[{start:request.start,end:'2026-01-31T23:59:30'},{start:'2026-01-31T23:59:30',end:request.end}]),'full');
 assert.equal(coverage(request.start,request.end,[{start:request.start,end:'2026-01-31T23:59:20'},{start:'2026-01-31T23:59:30',end:request.end}]),'partial');
 assert.equal(recover({jobs:[{status:'queued',clips:[{status:'transcoding'}]}]}).jobs[0].status,'interrupted');
});
test('无密码设备不阻断其他设备、无录像不重试、诊断不含敏感信息',async()=>{
 const dir=await temp();let calls=0;
 const adapter={call:async operation=>{calls++;if(operation==='discover')return {cameras:[{channel:1,name:'测试相机'}]};if(operation==='query')return {intervals:[]};throw Error('unexpected download')}};
 const s=await new Service({dataDir:dir,adapter,vault:vault(),env:{sdkDir:'private-path'}}).init();
 try{
 const id=await s.upsert(input);await s.discover(id);await s.settings({cacheRoot:path.join(dir,'cache')});
 const p=await s.preview({...request,cameras:[id+':1'],outputRoot:path.join(dir,'target')});assert.equal(p.clips[0].recording,'none');
 const result=await s.submit({previewId:p.id});await idle(s);assert.equal(s.job(result.id).clips[0].status,'no_recording');assert.equal(calls,2);
 const text=JSON.stringify(s.diagnostics());for(const value of [input.host,input.username,input.password,dir])assert.ok(!text.includes(value));
 assert.ok(!(await fs.readFile(path.join(dir,'state.json'),'utf8')).includes(input.password));
 }finally{await s.shutdown();await cleanup(dir)}
});
test('跨设备串行队列、目标校验和重启凭据隔离（合成录像）',async()=>{
 const dir=await temp();const raw=path.join(dir,'fixture.ps');
 assert.equal((await run('ffmpeg',['-y','-v','error','-f','lavfi','-i','testsrc2=size=160x120:rate=10','-t','3','-c:v','mpeg2video','-f','mpeg',raw])).code,0);
 let downloads=0,concurrency=0,max=0;
 const adapter={call:async(op,d,p,extra)=>{if(op==='discover')return {cameras:[{channel:1,name:'相机'}]};if(op==='query')return {intervals:[{start:extra.start,end:extra.end}]};concurrency++;max=Math.max(max,concurrency);downloads++;await fs.copyFile(raw,extra.raw);concurrency--;return {}}};
 const v=vault(),s=await new Service({dataDir:dir,adapter,vault:v,env:{}}).init();
 try{
 const a=await s.upsert(input),b=await s.upsert({...input,host:'192.0.2.2',name:'设备二'});await s.discover(a);await s.discover(b);await s.settings({cacheRoot:path.join(dir,'cache')});
 const p=await s.preview({...request,start:'2026-01-01T00:00:00',end:'2026-01-01T00:00:03',outputRoot:path.join(dir,'中文 目标'),cameras:[a+':1',b+':1']});
 await s.forget(a);const result=await s.submit({previewId:p.id});await idle(s);
 assert.equal(s.job(result.id).clips.find(c=>c.deviceId===a).status,'waiting_credentials');assert.equal(s.job(result.id).clips.find(c=>c.deviceId===b).status,'complete');assert.equal(downloads,1);
 await s.supply({id:a,password:input.password,remember:true});await s.retry(result.id);await idle(s);assert.equal(s.job(result.id).status,'complete');assert.equal(downloads,2);assert.equal(max,1);
 const report=await fs.readFile(path.join(s.job(result.id).outputDir,'任务清单.json'),'utf8');assert.ok(!report.includes(input.password));
 await s.retry(result.id,true);await idle(s);assert.equal(s.job(result.id).status,'complete');
 const clip=s.job(result.id).clips[0];await fs.writeFile(path.join(s.job(result.id).outputDir,clip.filename),'broken');await s.retry(result.id,true);await idle(s);assert.equal(s.job(result.id).clips[0].status,'failed');
 }finally{await s.shutdown();await cleanup(dir)}
});
test('查询取消、重复设备和预览确认边界',async()=>{
 const dir=await temp();const s=await new Service({dataDir:dir,vault:vault(),env:{},adapter:{call:async()=>({cameras:[{channel:2,name:'相机'}]})}}).init();
 try{const id=await s.upsert(input);await assert.rejects(s.upsert(input),/已经添加/);await s.discover(id);await assert.rejects(s.submit({previewId:'invalid'}),/预览/);await assert.rejects(s.camera({deviceId:id,channel:0,name:'bad'}),/通道/);await s.forget(id);await assert.rejects(s.password(s.device(id)),/输入密码/)}finally{await s.shutdown();await cleanup(dir)}
});
test('桌面代码语法与受限桥接',async()=>{
 for(const file of ['renderer.js','main.cjs','preload.cjs'])new vm.Script(await fs.readFile(new URL(file,import.meta.url),'utf8'));
 const main=await fs.readFile(new URL('main.cjs',import.meta.url),'utf8');assert.ok(main.includes('nodeIntegration:false'));assert.ok(main.includes('sandbox:true'));assert.ok(main.includes('event.senderFrame!==win.webContents.mainFrame'));
});
test('查询取消释放操作状态、鉴权失败阻止后续自动登录',async()=>{
 const dir=await temp();let queries=0,abortable=false;
 const adapter={call:async(op,d,p,extra,signal)=>{if(op==='discover')return {cameras:[{channel:1,name:'一'},{channel:2,name:'二'}]};queries++;if(abortable)return new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true})});const e=Error('凭据错误');e.auth=true;e.sdkCode=1;throw e}};
 const s=await new Service({dataDir:dir,adapter,vault:vault(),env:{}}).init();
 try{
  const id=await s.upsert(input);await s.discover(id);const r={...request,cameras:[id+':1',id+':2']};
  const p=await s.preview(r);assert.equal(queries,1);assert.ok(p.clips.every(c=>c.recording==='unknown'));
  await s.preview(r);assert.equal(queries,1);
  await s.supply({id,password:input.password,remember:false});abortable=true;
  const pending=s.preview(r);while(queries<2)await new Promise(r=>setTimeout(r,5));await s.cancelProbe();await assert.rejects(pending,/取消/);assert.equal(s.probing,null);
 }finally{await s.shutdown();await cleanup(dir)}
});
