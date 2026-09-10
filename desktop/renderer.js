'use strict';
const api=window.assistant,$=id=>document.getElementById(id),escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const names={pending:'等待下载',queued:'排队中',running:'处理中',downloading:'下载中',transcoding:'转码中',verifying:'校验中',copying:'保存中',retrying:'正在重试',complete:'已完成',failed:'失败',partial:'部分完成',cancelled:'已取消',interrupted:'已中断',waiting_credentials:'等待密码',no_recording:'无录像'};
const recordings={full:'有录像',partial:'部分覆盖',none:'无录像',unknown:'查询失败',unchecked:'未查询'};
let state,preview=null,currentJob=null,currentPage='download',selected=new Set(),busy=false,imported=[];
function message(text,error=false){$('notice').hidden=false;$('notice').className=error?'error':'success';$('notice').textContent=text}
function page(id){currentPage=id;for(const p of document.querySelectorAll('.page'))p.hidden=p.id!==id;for(const b of document.querySelectorAll('nav button'))b.classList.toggle('selected',b.dataset.page===id);$('pageTitle').textContent={download:'下载录像',tasks:'下载任务',devices:'设备与设置'}[id]}
async function action(fn){if(busy)return;busy=true;try{await fn();await refresh(true)}catch(e){message(e.message,true)}finally{busy=false}}
function invalidate(){preview=null;$('previewCard').hidden=true}
function form(){return {cameras:[...selected],mode:document.querySelector('[name=mode]:checked').value,start:$('start').value,end:$('end').value,startDate:$('startDate').value,endDate:$('endDate').value,times:$('times').value.split(/[,，\s]+/).filter(Boolean),minutes:Number($('minutes').value),outputRoot:$('outputRoot').value}}
function cameraRows(){
 const search=$('search').value.toLowerCase();$('selection').textContent=`已选 ${selected.size}`;
 $('cameras').innerHTML=state.devices.map(d=>{const cs=d.cameras.filter(c=>(d.name+' '+c.name).toLowerCase().includes(search));if(!cs.length)return '';return `<div class="group"><div class="group-head"><strong>${escape(d.name)}</strong><button data-select="${d.id}">全选 / 清空</button></div>${cs.map(c=>`<div class="camera-row"><label><input type="checkbox" data-camera="${d.id}:${c.channel}" ${selected.has(d.id+':'+c.channel)?'checked':''}><span>${escape(c.name)}<small>通道 ${c.channel} · ${c.manual?'兼容模式':c.online===null?'状态未知':c.online?'在线':'离线'}</small></span></label><button data-rename="${d.id}:${c.channel}">改名</button></div>`).join('')}</div>`}).join('')||'<div class="empty">还没有可选摄像头。<br>请添加设备并读取通道。</div>';
}
function deviceRows(){
 $('welcome').hidden=state.devices.length>0;
 $('deviceList').innerHTML=state.devices.map(d=>`<section class="card"><h2>${escape(d.name)}</h2><div class="device-address">${escape(d.host)}:${d.port}</div><p>${d.cameras.length} 个通道 · ${d.remember?'已加密记住密码':'密码仅本次运行有效'}</p><div class="actions"><button data-discover="${d.id}">连接 / 刷新</button><button data-credentials="${d.id}">输入密码</button><button data-edit="${d.id}">编辑</button><button data-manual="${d.id}">手动通道</button><button data-forget="${d.id}">忘记密码</button><button data-remove="${d.id}">删除</button></div></section>`).join('')||'<div class="empty">添加第一台录像机，开始使用。</div>';
 $('defaultOutput').value=state.settings.outputRoot;$('cacheRoot').value=state.settings.cacheRoot;
 if(!$('outputRoot').value)$('outputRoot').value=state.settings.outputRoot;
 const e=state.environment;$('environment').innerHTML=`<p>海康 SDK：<strong>${e.sdkDir?'已检测到':'未检测到'}</strong>　FFmpeg：<strong>${e.ffmpeg?'可用':'缺少'}</strong>　FFprobe：<strong>${e.ffprobe?'可用':'缺少'}</strong></p>`;
 $('health').hidden=!!(e.sdkDir&&e.ffmpeg&&e.ffprobe);$('health').textContent='运行组件尚未齐全，请前往“设备与设置”处理。本预览版未包含海康 SDK，不能视为完整免安装版。';
}
function table(clips,withActions=false){return `<table><thead><tr><th>设备 / 摄像头</th><th>起止时间</th><th>${withActions?'状态':'录像情况'}</th><th>${withActions?'结果':'时长'}</th></tr></thead><tbody>${clips.map((c,i)=>`<tr><td>${escape(c.deviceName)}<br>${escape(c.cameraName)} · CH ${c.channel}</td><td>${escape(c.start.replace('T',' '))}<br>${escape(c.end.replace('T',' '))}</td><td title="${escape(c.error||c.queryError||'')}">${escape(withActions?names[c.status]:recordings[c.recording])}${withActions&&c.status==='downloading'&&c.progress!==undefined?` ${c.progress}%`:''}${c.error?`<br>${escape(c.error)}`:''}</td><td>${withActions&&c.status==='complete'?`<button data-play="${i}">播放</button>`:c.seconds+' 秒'}</td></tr>`).join('')}</tbody></table>`}
function taskRows(){
 const filter=$('taskFilter').value,jobs=[...state.jobs].reverse().filter(j=>filter==='all'||filter==='complete'&&j.status==='complete'||filter==='active'&&['queued','running','verifying'].includes(j.status)||filter==='attention'&&!['queued','running','verifying','complete'].includes(j.status));
 $('jobList').innerHTML=jobs.map(j=>`<button class="job ${j.id===currentJob?'selected':''}" data-job="${j.id}"><strong>${new Date(j.createdAt).toLocaleString()}</strong><small>${names[j.status]} · ${j.clips.filter(c=>c.status==='complete').length} / ${j.clips.length} 段</small></button>`).join('')||'<div class="empty">暂无任务</div>';
 const j=state.jobs.find(j=>j.id===currentJob);if(!j){$('jobDetail').innerHTML='<div class="empty">选择任务查看进度与录像。</div>';return}
 const active=['queued','running','verifying'].includes(j.status),done=j.clips.filter(c=>c.status==='complete').length;
 $('jobDetail').innerHTML=`<h2>任务详情 <span class="badge">${names[j.status]}</span></h2><p>${escape(j.error||'每段均通过目标文件校验后，才会标记完成。')}</p><div class="metrics"><div><b>${done}</b><small>已完成</small></div><div><b>${j.clips.length-done}</b><small>其余片段</small></div></div><div class="actions"><button data-job-action="cancel" ${!active?'disabled':''}>取消</button><button data-job-action="retry" ${active?'disabled':''}>恢复 / 重试</button><button data-job-action="verify" ${active?'disabled':''}>重新校验</button><button data-job-action="openFolder">打开文件夹</button></div><p class="muted">${escape(j.outputDir)}</p><div class="table-wrap">${table(j.clips,true)}</div>`;
}
async function refresh(full=false){state=await api.snapshot();$('activity').textContent=state.probing?(state.queryProgress?`查询 ${state.queryProgress.current} / ${state.queryProgress.total}`:'正在查询设备'):state.active?'下载任务进行中':'准备就绪';$('cancelQuery').hidden=!state.probing;if(full){const available=new Set(state.devices.flatMap(d=>d.cameras.map(c=>d.id+':'+c.channel)));selected=new Set([...selected].filter(k=>available.has(k)));cameraRows();deviceRows()}taskRows()}
function deviceDialog(d){$('deviceId').value=d?.id||'';$('deviceName').value=d?.name||'';$('deviceHost').value=d?.host||'';$('devicePort').value=d?.port||8000;$('deviceUser').value=d?.username||'';$('devicePassword').value='';$('deviceRemember').checked=d?.remember||false;$('deviceTitle').textContent=d?'编辑录像机':'添加录像机';$('deviceDialog').showModal()}
document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>page(b.dataset.page));
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>$(b.dataset.close).close());
$('playerDialog').addEventListener('close',()=>{$('video').pause();$('video').removeAttribute('src');$('video').load()});
$('welcomeAdd').onclick=$('addDevice').onclick=()=>{imported=[];deviceDialog()};
$('deviceForm').onsubmit=e=>{e.preventDefault();void action(async()=>{const id=await api.saveDevice({id:$('deviceId').value||undefined,name:$('deviceName').value,host:$('deviceHost').value.trim(),port:Number($('devicePort').value),username:$('deviceUser').value,password:$('devicePassword').value,remember:$('deviceRemember').checked});$('devicePassword').value='';$('deviceDialog').close();page('devices');for(const c of imported)await api.camera({deviceId:id,...c});imported=[];message('设备已保存，正在测试连接并读取通道…');await api.discover(id);message('摄像头已读取，可返回“下载录像”选择。')})};
$('credentialForm').onsubmit=e=>{e.preventDefault();void action(async()=>{await api.supply({id:$('credentialId').value,password:$('credentialPassword').value,remember:$('credentialRemember').checked});$('credentialPassword').value='';$('credentialDialog').close();message('凭据已更新，请在任务页恢复任务。')})};
$('cameraForm').onsubmit=e=>{e.preventDefault();void action(async()=>{await api.camera({deviceId:$('cameraDevice').value,channel:Number($('cameraChannel').value),name:$('cameraName').value});$('cameraDialog').close();invalidate();message('摄像头已保存。')})};
document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;const d=b.dataset;
 if(d.edit){deviceDialog(state.devices.find(v=>v.id===d.edit));return}
 if(d.credentials){const device=state.devices.find(v=>v.id===d.credentials);$('credentialId').value=device.id;$('credentialName').textContent=device.name;$('credentialPassword').value='';$('credentialRemember').checked=device.remember;$('credentialDialog').showModal();return}
 if(d.manual||d.rename){const [id,ch]=d.rename?d.rename.split(':'):[d.manual,''];$('cameraDevice').value=id;$('cameraChannel').value=ch;$('cameraChannel').readOnly=!!ch;$('cameraName').value=ch?state.devices.find(v=>v.id===id).cameras.find(c=>c.channel===+ch).name:'';$('cameraDialog').showModal();return}
 if(d.select){const device=state.devices.find(v=>v.id===d.select),all=device.cameras.every(c=>selected.has(device.id+':'+c.channel));for(const c of device.cameras){const k=device.id+':'+c.channel;all?selected.delete(k):selected.add(k)}invalidate();cameraRows();return}
 if(d.job){currentJob=d.job;taskRows();return}
 if(d.discover)void action(async()=>{await api.discover(d.discover);invalidate();message('设备连接成功，通道已刷新。')});
 if(d.forget)void action(async()=>{await api.forget(d.forget);message('已清除保存的密码及本次内存凭据。')});
 if(d.remove&&confirm('删除这台设备？已有任务和录像保留。'))void action(async()=>{await api.removeDevice(d.remove);invalidate()});
 if(d.jobAction)void action(async()=>{await api[d.jobAction](currentJob);message('操作已提交。')});
 if(d.play!==undefined)void action(async()=>{$('video').src=await api.play({id:currentJob,index:+d.play});$('playerDialog').showModal();await $('video').play().catch(()=>{})});
});
$('cameras').onchange=e=>{if(e.target.dataset.camera){e.target.checked?selected.add(e.target.dataset.camera):selected.delete(e.target.dataset.camera);invalidate();$('selection').textContent=`已选 ${selected.size}`}};
$('search').oninput=cameraRows;$('taskFilter').onchange=taskRows;
document.querySelectorAll('[name=mode]').forEach(i=>i.onchange=()=>{$('rangeFields').hidden=i.value==='daily';$('dailyFields').hidden=i.value==='range';invalidate()});
for(const id of ['start','end','startDate','endDate','times','minutes','outputRoot'])$(id).oninput=invalidate;
$('chooseOutput').onclick=()=>action(async()=>{const p=await api.chooseFolder();if(p){$('outputRoot').value=p;invalidate()}});
for(const [button,key] of [['defaultOutputPick','outputRoot'],['cachePick','cacheRoot']])$(button).onclick=()=>action(async()=>{const p=await api.chooseFolder();if(p){await api.settings({[key]:p});if(key==='outputRoot')$('outputRoot').value=p;invalidate()}});
$('sdkPick').onclick=()=>action(async()=>{await api.chooseSdk();message('SDK 目录已更新。')});
async function previewRun(sample){invalidate();const input=form();if(sample){input.mode='range';const s=input.start||input.startDate+'T12:00:00';input.start=s;input.end=new Date(Date.parse((s.length===16?s+':00':s)+'Z')+10000).toISOString().slice(0,19)}message('正在查询录像，完成后可确认下载。');preview=await api.preview(input);$('previewCard').hidden=false;$('previewSummary').textContent=`${preview.clips.length} 段 · ${new Set(preview.clips.map(c=>c.deviceId)).size} 台设备 · 保存到 ${preview.outputRoot}`;$('previewTable').innerHTML=table(preview.clips);$('allowUnknown').checked=false;message(sample?'10 秒片段已准备，加入队列下载后可播放确认。':'预览已生成，请核对后加入队列。')}
$('preview').onclick=()=>action(()=>previewRun(false));$('sample').onclick=()=>action(()=>previewRun(true));
$('cancelQuery').onclick=async()=>{await api.cancelProbe();message('已请求取消查询。')};
$('submit').onclick=()=>action(async()=>{if(!preview)throw Error('请重新预览');const r=await api.submit({previewId:preview.id,allowUnknown:$('allowUnknown').checked});currentJob=r.id;invalidate();page('tasks');message(r.duplicate?'已找到相同任务，未重复创建。':'任务已加入队列。')});
$('diagnostic').onclick=()=>action(async()=>{$('diagnosticText').textContent=JSON.stringify(await api.diagnostics(),null,2);$('diagnosticDialog').showModal()});
$('exportDiagnostic').onclick=()=>action(async()=>{await api.exportDiagnostics()});
$('importLegacy').onclick=()=>action(async()=>{const v=await api.importLegacy();if(v){imported=v.cameras;deviceDialog({name:'导入的录像机',host:v.host,port:v.port});message('请补充用户名和密码。只导入设备与通道，不导入历史。')}});
const now=new Date(),local=d=>new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,19);$('end').value=local(new Date(now.getTime()-3600000));$('start').value=local(new Date(now.getTime()-4200000));$('startDate').value=$('endDate').value=local(now).slice(0,10);
void refresh(true).catch(e=>message(e.message,true));setInterval(()=>{if(document.visibilityState==='visible')void refresh(false).catch(()=>{})},1500);
