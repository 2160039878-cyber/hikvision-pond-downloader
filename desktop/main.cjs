const {app,BrowserWindow,Tray,Menu,nativeImage,dialog,ipcMain,safeStorage,shell,protocol}=require('electron');
const path=require('node:path');
const fs=require('node:fs/promises');
const {createReadStream}=require('node:fs');
const {Readable}=require('node:stream');
const {pathToFileURL}=require('node:url');
protocol.registerSchemesAsPrivileged([{scheme:'recording',privileges:{standard:true,secure:true,stream:true,supportFetchAPI:true}}]);
let win,tray,service,quitting=false;
if(!app.requestSingleInstanceLock()){app.quit()}else{
app.on('second-instance',()=>{win?.show();win?.focus()});
app.whenReady().then(async()=>{
  const {environment,Adapter}=await import('./adapter.mjs');
  const {Service}=await import('./service.mjs');
  const {byteRange}=await import('../core.mjs');
  const resources=app.isPackaged?process.resourcesPath:__dirname;
  const dataDir=process.env.HIK_V2_TEST_DATA||app.getPath('userData');
  await fs.mkdir(dataDir,{recursive:true});
  const credentialFile=path.join(dataDir,'credentials.enc.json');
  let secrets={};try{secrets=JSON.parse(await fs.readFile(credentialFile,'utf8'))}catch(e){if(e.code!=='ENOENT')throw Error('密码存储损坏，请保留数据后处理')}
  const saveSecrets=async()=>{await fs.writeFile(credentialFile+'.tmp',JSON.stringify(secrets));await fs.rename(credentialFile+'.tmp',credentialFile)};
  const vault={
    get:async id=>{if(!secrets[id])return null;if(!safeStorage.isEncryptionAvailable())throw Error('Windows 加密服务不可用');return safeStorage.decryptString(Buffer.from(secrets[id],'base64'))},
    set:async(id,password)=>{if(!safeStorage.isEncryptionAvailable())throw Error('Windows 加密服务不可用，不能保存密码');secrets[id]=safeStorage.encryptString(password).toString('base64');await saveSecrets()},
    remove:async id=>{delete secrets[id];await saveSecrets()}
  };
  const env=await environment(resources);
  service=await new Service({dataDir,adapter:new Adapter(env),vault,env}).init();
  const pixels=Buffer.alloc(32*32*4);for(let y=0;y<32;y++)for(let x=0;x<32;x++){const i=(y*32+x)*4,play=x>=11&&x<24&&Math.abs(y-16)<(24-x)*0.65;pixels[i]=play?255:103;pixels[i+1]=play?255:108;pixels[i+2]=play?255:18;pixels[i+3]=255}const icon=nativeImage.createFromBitmap(pixels,{width:32,height:32});
  win=new BrowserWindow({width:1280,height:880,minWidth:920,minHeight:680,title:'海康录像下载助手 2.0 · 预览版',backgroundColor:'#f4f6f8',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  win.removeMenu();win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',e=>e.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  let firstClose=true;
  win.on('close',e=>{if(!quitting){e.preventDefault();win.hide();if(firstClose){firstClose=false;tray.displayBalloon({title:'下载继续运行',content:'窗口已收起到托盘；右键托盘图标可打开或退出。'})}}});
  tray=new Tray(icon);tray.setToolTip('海康录像下载助手');tray.on('double-click',()=>win.show());
  tray.setContextMenu(Menu.buildFromTemplate([{label:'打开下载助手',click:()=>win.show()},{label:'退出（保存并停止任务）',click:()=>app.quit()}]));
  const folder=async()=>{const r=await dialog.showOpenDialog(win,{properties:['openDirectory','createDirectory']});return r.canceled?null:r.filePaths[0]};
  const handlers={
    snapshot:()=>service.snapshot(),saveDevice:v=>service.upsert(v),removeDevice:id=>service.remove(id),discover:id=>service.discover(id),camera:v=>service.camera(v),forget:id=>service.forget(id),supply:v=>service.supply(v),settings:v=>service.settings(v),chooseFolder:folder,
    chooseSdk:async()=>{if(service.active||service.probing)throw Error('请等待当前操作结束');const p=await folder();if(!p)return null;const dll=await fs.readFile(path.join(p,'HCNetSDK.dll'));if(dll.readUInt16LE(dll.readUInt32LE(60)+4)!==0x8664)throw Error('请选择 64 位 SDK');service.env.sdkDir=p;service.state.settings.sdkDir=p;await service.save();return p},
    preview:v=>service.preview(v),cancelProbe:()=>service.cancelProbe(),submit:v=>service.submit(v),cancel:id=>service.cancel(id),retry:id=>service.retry(id),verify:id=>service.retry(id,true),
    openFolder:async id=>{const result=await shell.openPath(service.job(id).outputDir);if(result)throw Error('无法打开目录，请检查磁盘连接')},
    play:({id,index})=>{service.media(id,index);return `recording://media/${id}/${index}`},diagnostics:()=>service.diagnostics(),
    exportDiagnostics:async()=>{const r=await dialog.showSaveDialog(win,{defaultPath:'脱敏诊断.json',filters:[{name:'JSON',extensions:['json']}]});if(r.canceled)return false;await fs.writeFile(r.filePath,JSON.stringify(service.diagnostics(),null,2));return true},
    importLegacy:async()=>{const r=await dialog.showOpenDialog(win,{properties:['openFile'],filters:[{name:'旧版 config.json',extensions:['json']}]});if(r.canceled)return null;const v=JSON.parse(await fs.readFile(r.filePaths[0],'utf8'));if(!v.deviceIp||!v.channels)throw Error('不是旧版配置文件');return {host:v.deviceIp,port:v.sdkPort||8000,cameras:Object.entries(v.channels).filter(([,channel])=>Number.isInteger(channel)).map(([name,channel])=>({name,channel}))}}
  };
  let mutationBusy=false;
  const concurrent=new Set(['snapshot','cancelProbe','cancel','play','openFolder','diagnostics']);
  for(const [name,fn] of Object.entries(handlers))ipcMain.handle('assistant:'+name,async(event,v)=>{
    if(event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame||event.senderFrame.url!==pathToFileURL(path.join(__dirname,'index.html')).href)return {ok:false,error:'请求来源无效'};
    const mutation=!concurrent.has(name);if(mutation&&mutationBusy)return {ok:false,error:'另一项操作正在处理，请稍后重试'};
    if(mutation)mutationBusy=true;
    try{if(JSON.stringify(v??null).length>2000000)throw Error('请求过大');return {ok:true,value:await fn(v)}}catch(e){return {ok:false,error:e.message}}finally{if(mutation)mutationBusy=false}
  });
  protocol.handle('recording',async request=>{
    try{const u=new URL(request.url),m=/^\/([\da-f-]+)\/(\d+)$/.exec(u.pathname);if(u.hostname!=='media'||!m)return new Response(null,{status:404});const file=service.media(m[1],+m[2]),size=(await fs.stat(file)).size;let range;try{range=byteRange(request.headers.get('range'),size)}catch{return new Response(null,{status:416,headers:{'Content-Range':`bytes */${size}`}})}
    return new Response(Readable.toWeb(createReadStream(file,range||{})),{status:range?206:200,headers:{'Content-Type':'video/mp4','Accept-Ranges':'bytes','Content-Length':String(range?range.end-range.start+1:size),...(range?{'Content-Range':`bytes ${range.start}-${range.end}/${size}`}:{})}})}catch{return new Response(null,{status:404})}
  });
  await win.loadFile(path.join(__dirname,'index.html'));
}).catch(e=>{dialog.showErrorBox('启动失败',e.message);quitting=true;app.quit()});
app.on('before-quit',e=>{if(!quitting){e.preventDefault();quitting=true;service?.shutdown().finally(()=>app.quit())||app.quit()}});
}
