$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'sdk-common.ps1')
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class ProbeNative {
 [DllImport("HCNetSDK.dll")] public static extern bool NET_DVR_GetDVRConfig(int user, uint command, int channel, IntPtr buffer, uint size, ref uint returned);
 [DllImport("HCNetSDK.dll")] public static extern int NET_DVR_FindFile_V30(int user, IntPtr condition);
 [DllImport("HCNetSDK.dll")] public static extern int NET_DVR_FindNextFile_V30(int handle, IntPtr result);
 [DllImport("HCNetSDK.dll")] public static extern bool NET_DVR_FindClose_V30(int handle);
}
"@
function New-Buffer([int]$Size) {
 $p = [Runtime.InteropServices.Marshal]::AllocHGlobal($Size)
 [Runtime.InteropServices.Marshal]::Copy((New-Object byte[] $Size),0,$p,$Size)
 return $p
}
function Put-Time($buffer,[int]$offset,[string]$value) {
 $t=[datetime]::ParseExact($value,'yyyy-MM-ddTHH:mm:ss',[Globalization.CultureInfo]::InvariantCulture)
 $parts=@($t.Year,$t.Month,$t.Day,$t.Hour,$t.Minute,$t.Second)
 for($i=0;$i -lt 6;$i++){[Runtime.InteropServices.Marshal]::WriteInt32($buffer,($offset+$i*4),$parts[$i])}
}
function Read-Time($buffer,[int]$offset) {
 $v=@(); for($i=0;$i -lt 6;$i++){$v += [Runtime.InteropServices.Marshal]::ReadInt32($buffer,($offset+$i*4))}
 return ('{0:D4}-{1:D2}-{2:D2}T{3:D2}:{4:D2}:{5:D2}' -f $v)
}
$login=$null; $inputData=$null; $find=-1
try {
 $inputData=@{}
 foreach($key in @('host','port','username','password','sdkDir','cancelPath','operation','channel','start','end')) {
   $inputData[$key]=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::ReadLine()))
 }
 Initialize-HikSdk -Directory $inputData.sdkDir
 $login=Login-HikDevice -Ip $inputData.host -Port $inputData.port -Username $inputData.username -Password $inputData.password
 if($inputData.operation -eq 'discover') {
   $info=$login.DeviceInfo; $channels=@()
   $count=[int]$info.byIPChanNum+256*[int]$info.byHighDChanNum
   $numbers=@(); $online=@{}; $configRead=$false
   for($i=0;$i -lt [int]$info.byChanNum;$i++){$numbers += [int]$info.byStartChan+$i}
   for($i=0;$i -lt $count;$i++){$numbers += [int]$info.byStartDChan+$i}
   # NET_DVR_IPPARACFG_V40: header 84, 64 x IPDEVINFO_V31(296),
   # 64 x STREAM_MODE(496), tail 20. Never expose the IPDEVINFO credential fields.
   for($group=0;$group -lt [Math]::Ceiling($count/64.0);$group++){
     $cfg=New-Buffer 50792
     try{
       [Runtime.InteropServices.Marshal]::WriteInt32($cfg,0,50792);$returned=[uint32]0
       if([ProbeNative]::NET_DVR_GetDVRConfig($login.UserId,1062,$group,$cfg,50792,[ref]$returned) -and $returned -ge 50792){
         $configRead=$true;$start=[Runtime.InteropServices.Marshal]::ReadInt32($cfg,16)
         for($i=0;$i -lt [Math]::Min(64,$count-$group*64);$i++){
           $n=$start+$group*64+$i;$offset=19028+$i*496;$mode=[Runtime.InteropServices.Marshal]::ReadByte($cfg,$offset)
           if($mode -eq 0 -or $mode -eq 6){
             $ipid=if($mode -eq 0){[int][Runtime.InteropServices.Marshal]::ReadByte($cfg,($offset+5))+256*[int][Runtime.InteropServices.Marshal]::ReadByte($cfg,($offset+7))}else{[int][Runtime.InteropServices.Marshal]::ReadInt16($cfg,($offset+6)) -band 65535}
             if($ipid -eq 0){$numbers=@($numbers | Where-Object {$_ -ne $n})}else{$online[$n]=[int][Runtime.InteropServices.Marshal]::ReadByte($cfg,($offset+4))}
           }
         }
       }
     }finally{[Runtime.InteropServices.Marshal]::Copy((New-Object byte[] 50792),0,$cfg,50792);[Runtime.InteropServices.Marshal]::FreeHGlobal($cfg)}
   }
   foreach($n in $numbers) {
     if(Test-Path -LiteralPath $inputData.cancelPath){throw 'Cancelled'}
     $name="通道 $n"; $readable=$false; $p=New-Buffer 65536
     try {
       $returned=[uint32]0
       if([ProbeNative]::NET_DVR_GetDVRConfig($login.UserId,1002,$n,$p,65536,[ref]$returned)) {
         $bytes=New-Object byte[] 32; [Runtime.InteropServices.Marshal]::Copy([IntPtr]::Add($p,4),$bytes,0,32)
         try {$decoded=[Text.UTF8Encoding]::new($false,$true).GetString($bytes).Trim([char]0)}catch{$decoded=[Text.Encoding]::GetEncoding(936).GetString($bytes).Trim([char]0)}
         if($decoded){$name=$decoded}; $readable=$true
       }
     } finally {[Runtime.InteropServices.Marshal]::FreeHGlobal($p)}
     $channels += @{channel=$n;name=$name;online=$(if($online.ContainsKey($n)){$online[$n]}else{-1});nameRead=$readable;manual=$false}
   }
   $result=@{cameras=@($channels);deviceType=[int]$info.wDevType;digitalStart=[int]$info.byStartDChan;configRead=$configRead}
 } elseif($inputData.operation -eq 'query') {
   $condition=New-Buffer 96; $data=New-Buffer 188
   try {
     [Runtime.InteropServices.Marshal]::WriteInt32($condition,0,[int]$inputData.channel)
     [Runtime.InteropServices.Marshal]::WriteInt32($condition,4,255)
     [Runtime.InteropServices.Marshal]::WriteInt32($condition,8,255)
     Put-Time $condition 48 $inputData.start; Put-Time $condition 72 $inputData.end
     $find=[ProbeNative]::NET_DVR_FindFile_V30($login.UserId,$condition)
     if($find -lt 0){throw 'Find failed'}
     $intervals=@(); $deadline=(Get-Date).AddSeconds(45)
     while($true) {
       if((Get-Date) -gt $deadline){throw 'Query timeout'}
       if(Test-Path -LiteralPath $inputData.cancelPath){throw 'Cancelled'}
       $status=[ProbeNative]::NET_DVR_FindNextFile_V30($find,$data)
       if($status -eq 1000){$intervals += @{start=(Read-Time $data 100);end=(Read-Time $data 124)}; if($intervals.Count -gt 10000){throw 'Too many files'}}
       elseif($status -eq 1002){Start-Sleep -Milliseconds 100}
       elseif($status -eq 1001 -or $status -eq 1003){break}
       else {throw 'Find next failed'}
     }
     $result=@{intervals=@($intervals)}
   } finally {
     if($find -ge 0){[ProbeNative]::NET_DVR_FindClose_V30($find) | Out-Null; $find=-1}
     [Runtime.InteropServices.Marshal]::FreeHGlobal($condition);[Runtime.InteropServices.Marshal]::FreeHGlobal($data)
   }
 } else {throw 'Unsupported operation'}
 if($inputData.operation -eq 'discover'){
   Write-Output ('META:' + $result.deviceType+':'+[int]$result.configRead)
   foreach($camera in $result.cameras){Write-Output ('CAMERA:'+$camera.channel+':'+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($camera.name))+':'+[int]$camera.nameRead+':'+$camera.online)}
 } else {foreach($interval in $result.intervals){Write-Output ('INTERVAL:'+$interval.start+'|'+$interval.end)}}
 Write-Output 'OK'
} catch {
 Write-Output ('DIAGNOSTIC:line=' + $_.InvocationInfo.ScriptLineNumber + ';type=' + $_.Exception.GetType().Name)
 $code=0; try {$code=[HikvisionClipDownloader.HCNetSDK]::NET_DVR_GetLastError()}catch{}
 Write-Output ('ERROR:'+$code)
 exit 2
} finally {
 $inputData=$null
 if($login){[HikvisionClipDownloader.HCNetSDK]::NET_DVR_Logout($login.UserId) | Out-Null}
 try {[HikvisionClipDownloader.HCNetSDK]::NET_DVR_Cleanup() | Out-Null}catch{}
}
