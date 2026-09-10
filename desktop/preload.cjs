const { contextBridge, ipcRenderer } = require('electron');
const methods=['snapshot','saveDevice','removeDevice','discover','camera','forget','supply','settings','chooseFolder','chooseSdk','preview','cancelProbe','submit','cancel','retry','verify','openFolder','play','diagnostics','exportDiagnostics','importLegacy'];
contextBridge.exposeInMainWorld('assistant',Object.fromEntries(methods.map(name=>[name,async value=>{const r=await ipcRenderer.invoke('assistant:'+name,value);if(!r.ok)throw Error(r.error);return r.value}])));
