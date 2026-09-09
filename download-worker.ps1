function Write-Step {
    param([string]$Message)
    Write-Host ("[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $Message)
}

function ConvertTo-PlainText {
    param([Security.SecureString]$Secure)
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
    try {
        [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}

function New-HikTime {
    param([datetime]$DateTime)
    $t = New-Object HikvisionClipDownloader.NET_DVR_TIME
    $t.dwYear = [uint32]$DateTime.Year
    $t.dwMonth = [uint32]$DateTime.Month
    $t.dwDay = [uint32]$DateTime.Day
    $t.dwHour = [uint32]$DateTime.Hour
    $t.dwMinute = [uint32]$DateTime.Minute
    $t.dwSecond = [uint32]$DateTime.Second
    $t
}

function Get-OutputFileName {
    param(
        [string]$Label,
        [datetime]$StartTime,
        [int]$SdkChannel,
        [string]$Extension
    )
    if ([string]::IsNullOrWhiteSpace($Extension)) {
        $Extension = ".ps"
    }
    if (-not $Extension.StartsWith(".")) {
        $Extension = ".$Extension"
    }
    "pool{0}_{1}_ch{2}{3}" -f $Label, $StartTime.ToString("yyyyMMdd_HHmm"), $SdkChannel, $Extension
}

function Initialize-HikSdk {
    param([string]$Directory)

    if (-not (Test-Path -LiteralPath (Join-Path $Directory "HCNetSDK.dll"))) {
        throw "HCNetSDK.dll not found in: $Directory"
    }

    $componentDir = Join-Path $Directory "HCNetSDKCom"
    if (Test-Path -LiteralPath $componentDir) {
        $env:PATH = "$Directory;$componentDir;$env:PATH"
    }
    else {
        $env:PATH = "$Directory;$env:PATH"
    }

    $loaderType = [System.Management.Automation.PSTypeName]"HikvisionClipDownloader.NativeDllSearch"
    if (-not $loaderType.Type) {
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

namespace HikvisionClipDownloader
{
    public static class NativeDllSearch
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool SetDllDirectory(string lpPathName);
    }
}
"@
    }

    [HikvisionClipDownloader.NativeDllSearch]::SetDllDirectory($Directory) | Out-Null

    $sdkType = [System.Management.Automation.PSTypeName]"HikvisionClipDownloader.HCNetSDK"
    if (-not $sdkType.Type) {
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

namespace HikvisionClipDownloader
{
    [StructLayout(LayoutKind.Sequential)]
    public struct NET_DVR_TIME
    {
        public UInt32 dwYear;
        public UInt32 dwMonth;
        public UInt32 dwDay;
        public UInt32 dwHour;
        public UInt32 dwMinute;
        public UInt32 dwSecond;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct NET_DVR_DEVICEINFO_V30
    {
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 48)]
        public byte[] sSerialNumber;
        public byte byAlarmInPortNum;
        public byte byAlarmOutPortNum;
        public byte byDiskNum;
        public byte byDVRType;
        public byte byChanNum;
        public byte byStartChan;
        public byte byAudioChanNum;
        public byte byIPChanNum;
        public byte byZeroChanNum;
        public byte byMainProto;
        public byte bySubProto;
        public byte bySupport;
        public byte bySupport1;
        public byte bySupport2;
        public UInt16 wDevType;
        public byte bySupport3;
        public byte byMultiStreamProto;
        public byte byStartDChan;
        public byte byStartDTalkChan;
        public byte byHighDChanNum;
        public byte bySupport4;
        public byte byLanguageType;
        public byte byVoiceInChanNum;
        public byte byStartVoiceInChanNo;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 2)]
        public byte[] byRes3;
        public byte byMirrorChanNum;
        public UInt16 wStartMirrorChanNo;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 2)]
        public byte[] byRes2;
    }

    public static class HCNetSDK
    {
        [DllImport("HCNetSDK.dll", CallingConvention = CallingConvention.StdCall)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool NET_DVR_Init();

        [DllImport("HCNetSDK.dll", CallingConvention = CallingConvention.StdCall)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool NET_DVR_Cleanup();

        [DllImport("HCNetSDK.dll", CallingConvention = CallingConvention.StdCall)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool NET_DVR_GetSDKLocalCfg(int type, IntPtr buffer);

        [DllImport("HCNetSDK.dll", CallingConvention = CallingConvention.StdCall)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool NET_DVR_SetSDKLocalCfg(int type, IntPtr buffer);

        [DllImport("HCNetSDK.dll", CallingConvention = CallingConvention.StdCall)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool NET_DVR_Logout(int lUserID);

        [DllImport("HCNetSDK.dll", CallingConvention = CallingConvention.StdCall)]
        public static extern UInt32 NET_DVR_GetLastError();

        [DllImport("HCNetSDK.dll", CallingConvention = CallingConvention.StdCall)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool NET_DVR_SetConnectTime(UInt32 dwWaitTime, UInt32 dwTryTimes);

        [DllImport("HCNetSDK.dll", CallingConvention = CallingConvention.StdCall)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool NET_DVR_SetReconnect(UInt32 dwInterval, bool bEnableRecon);

        [DllImport("HCNetSDK.dll", CharSet = CharSet.Ansi, CallingConvention = CallingConvention.StdCall)]
        public static extern int NET_DVR_Login_V30(
            string sDVRIP,
            UInt16 wDVRPort,
            string sUserName,
            string sPassword,
            ref NET_DVR_DEVICEINFO_V30 lpDeviceInfo
        );

        [DllImport("HCNetSDK.dll", CharSet = CharSet.Ansi, CallingConvention = CallingConvention.StdCall)]
        public static extern int NET_DVR_GetFileByTime(
            int lUserID,
            int lChannel,
            ref NET_DVR_TIME lpStartTime,
            ref NET_DVR_TIME lpStopTime,
            string sSavedFileName
        );

        [DllImport("HCNetSDK.dll", CallingConvention = CallingConvention.StdCall)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool NET_DVR_PlayBackControl(
            int lPlayHandle,
            UInt32 dwControlCode,
            UInt32 dwInValue,
            ref UInt32 lpOutValue
        );

        [DllImport("HCNetSDK.dll", CallingConvention = CallingConvention.StdCall)]
        public static extern int NET_DVR_GetDownloadPos(int lFileHandle);

        [DllImport("HCNetSDK.dll", CallingConvention = CallingConvention.StdCall)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool NET_DVR_StopGetFile(int lFileHandle);
    }
}
"@
    }

    if (-not [HikvisionClipDownloader.HCNetSDK]::NET_DVR_Init()) {
        throw "HCNetSDK init failed. SDK error: $([HikvisionClipDownloader.HCNetSDK]::NET_DVR_GetLastError())"
    }

    # Official NET_DVR_LOCAL_GENERAL_CFG: disable automatic 1 GB splitting in this worker only.
    $cfg = [Runtime.InteropServices.Marshal]::AllocHGlobal(256)
    try {
        [Runtime.InteropServices.Marshal]::Copy((New-Object byte[] 256), 0, $cfg, 256)
        if (-not [HikvisionClipDownloader.HCNetSDK]::NET_DVR_GetSDKLocalCfg(17, $cfg)) { throw 'Cannot read local SDK split config' }
        [Runtime.InteropServices.Marshal]::WriteByte($cfg, 1, 1)
        if (-not [HikvisionClipDownloader.HCNetSDK]::NET_DVR_SetSDKLocalCfg(17, $cfg)) { throw 'Cannot disable local SDK splitting' }
    }
    finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($cfg) }

    [HikvisionClipDownloader.HCNetSDK]::NET_DVR_SetConnectTime(5000, 2) | Out-Null
    [HikvisionClipDownloader.HCNetSDK]::NET_DVR_SetReconnect(10000, $true) | Out-Null
}

function Login-HikDevice {
    param(
        [string]$Ip,
        [UInt16]$Port,
        [string]$Username,
        [string]$Password
    )

    $deviceInfo = New-Object HikvisionClipDownloader.NET_DVR_DEVICEINFO_V30
    $deviceInfo.sSerialNumber = New-Object byte[] 48
    $deviceInfo.byRes3 = New-Object byte[] 2
    $deviceInfo.byRes2 = New-Object byte[] 2

    $userId = [HikvisionClipDownloader.HCNetSDK]::NET_DVR_Login_V30($Ip, $Port, $Username, $Password, [ref]$deviceInfo)
    if ($userId -lt 0) {
        throw "Login failed. SDK error: $([HikvisionClipDownloader.HCNetSDK]::NET_DVR_GetLastError())"
    }

    [pscustomobject]@{
        UserId = $userId
        DeviceInfo = $deviceInfo
    }
}

function Download-Clip {
    param(
        [int]$UserId,
        [pscustomobject]$Camera,
        [datetime]$StartTime,
        [datetime]$EndTime,
        [string]$Destination,
        [int]$TimeoutSeconds
    )

    $partial = "$Destination.partial"
    if ((Test-Path -LiteralPath $Destination) -and -not $Overwrite) {
        return [pscustomobject]@{
            Camera = $Camera.Name
            Label = $Camera.Label
            SdkChannel = $Camera.SdkChannel
            StartTime = $StartTime
            EndTime = $EndTime
            File = $Destination
            Status = "skipped_exists"
            ErrorCode = ""
            Detail = "File already exists"
        }
    }

    Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
    if ($Overwrite) {
        Remove-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue
    }

    $sdkStart = New-HikTime $StartTime
    $sdkEnd = New-HikTime $EndTime
    $handle = [HikvisionClipDownloader.HCNetSDK]::NET_DVR_GetFileByTime(
        $UserId,
        [int]$Camera.SdkChannel,
        [ref]$sdkStart,
        [ref]$sdkEnd,
        $partial
    )

    if ($handle -lt 0) {
        return [pscustomobject]@{
            Camera = $Camera.Name
            Label = $Camera.Label
            SdkChannel = $Camera.SdkChannel
            StartTime = $StartTime
            EndTime = $EndTime
            File = $Destination
            Status = "failed_get_handle"
            ErrorCode = [HikvisionClipDownloader.HCNetSDK]::NET_DVR_GetLastError()
            Detail = "NET_DVR_GetFileByTime failed"
        }
    }

    $outValue = [uint32]0
    try {
        if (-not [HikvisionClipDownloader.HCNetSDK]::NET_DVR_PlayBackControl($handle, 1, 0, [ref]$outValue)) {
            return [pscustomobject]@{
                Camera = $Camera.Name
                Label = $Camera.Label
                SdkChannel = $Camera.SdkChannel
                StartTime = $StartTime
                EndTime = $EndTime
                File = $Destination
                Status = "failed_start"
                ErrorCode = [HikvisionClipDownloader.HCNetSDK]::NET_DVR_GetLastError()
                Detail = "NET_DVR_PLAYSTART failed"
            }
        }

        $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
        $lastPos = -1
        $lastSize = -1L
        $lastActivity = Get-Date
        while ((Get-Date) -lt $deadline) {
            Start-Sleep -Seconds 2
            if (Test-Path -LiteralPath $script:cancelPath) { throw "Cancelled" }
            $pos = [HikvisionClipDownloader.HCNetSDK]::NET_DVR_GetDownloadPos($handle)
            $currentSize = 0L
            if (Test-Path -LiteralPath $partial) {
                $currentSize = (Get-Item -LiteralPath $partial).Length
            }
            $posChanged = $pos -ne $lastPos
            $sizeChanged = $currentSize -ne $lastSize
            if ($posChanged) {
                Write-Host "PROGRESS:$pos"
                $lastPos = $pos
            }
            if ($posChanged -or $sizeChanged) {
                $lastActivity = Get-Date
                $lastSize = $currentSize
            }
            if ((Get-Date) -gt $lastActivity.AddSeconds($StallTimeoutSeconds)) {
                return [pscustomobject]@{
                    Camera = $Camera.Name
                    Label = $Camera.Label
                    SdkChannel = $Camera.SdkChannel
                    StartTime = $StartTime
                    EndTime = $EndTime
                    File = $Destination
                    Status = "failed_stalled"
                    ErrorCode = [HikvisionClipDownloader.HCNetSDK]::NET_DVR_GetLastError()
                    Detail = "No progress for $StallTimeoutSeconds seconds; last progress $pos; bytes $currentSize"
                }
            }
            if ($pos -lt 0) {
                return [pscustomobject]@{
                    Camera = $Camera.Name
                    Label = $Camera.Label
                    SdkChannel = $Camera.SdkChannel
                    StartTime = $StartTime
                    EndTime = $EndTime
                    File = $Destination
                    Status = "failed_progress"
                    ErrorCode = [HikvisionClipDownloader.HCNetSDK]::NET_DVR_GetLastError()
                    Detail = "Download progress failed"
                }
            }
            if ($pos -eq 100) {
                [HikvisionClipDownloader.HCNetSDK]::NET_DVR_StopGetFile($handle) | Out-Null
                $handle = -1
                if (-not (Test-Path -LiteralPath $partial)) {
                    return [pscustomobject]@{
                        Camera = $Camera.Name
                        Label = $Camera.Label
                        SdkChannel = $Camera.SdkChannel
                        StartTime = $StartTime
                        EndTime = $EndTime
                        File = $Destination
                        Status = "failed_missing_file"
                        ErrorCode = ""
                        Detail = "SDK reported complete but output file is missing"
                    }
                }
                if (Test-Path -LiteralPath $Destination) {
                    Remove-Item -LiteralPath $Destination -Force
                }
                Move-Item -LiteralPath $partial -Destination $Destination -Force
                return [pscustomobject]@{
                    Camera = $Camera.Name
                    Label = $Camera.Label
                    SdkChannel = $Camera.SdkChannel
                    StartTime = $StartTime
                    EndTime = $EndTime
                    File = $Destination
                    Status = "ok"
                    ErrorCode = ""
                    Detail = "Downloaded"
                }
            }
            if ($pos -gt 100) {
                return [pscustomobject]@{
                    Camera = $Camera.Name
                    Label = $Camera.Label
                    SdkChannel = $Camera.SdkChannel
                    StartTime = $StartTime
                    EndTime = $EndTime
                    File = $Destination
                    Status = "failed_unexpected_progress"
                    ErrorCode = [HikvisionClipDownloader.HCNetSDK]::NET_DVR_GetLastError()
                    Detail = "Unexpected SDK progress: $pos"
                }
            }
        }

        [pscustomobject]@{
            Camera = $Camera.Name
            Label = $Camera.Label
            SdkChannel = $Camera.SdkChannel
            StartTime = $StartTime
            EndTime = $EndTime
            File = $Destination
            Status = "failed_timeout"
            ErrorCode = ""
            Detail = "Timed out after $TimeoutSeconds seconds"
        }
    }
    finally {
        if ($handle -ge 0) {
            [HikvisionClipDownloader.HCNetSDK]::NET_DVR_StopGetFile($handle) | Out-Null
        }
        Write-Progress -Activity ("Download {0} {1}" -f $Camera.Name, $StartTime.ToString("HH:mm")) -Completed
    }
}


$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Overwrite = $false
$StallTimeoutSeconds = 120
function Read-Field {
    $line = [Console]::ReadLine()
    if ($null -eq $line) { throw 'Missing worker input' }
    [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line))
}
$login = $null
$password = $null
try {
    $deviceIp = Read-Field
    $port = [UInt16](Read-Field)
    $sdkDir = Read-Field
    $username = Read-Field
    $password = Read-Field
    $channel = [int](Read-Field)
    $start = [datetime]::ParseExact((Read-Field), 'yyyy-MM-ddTHH:mm:ss', [Globalization.CultureInfo]::InvariantCulture)
    $end = [datetime]::ParseExact((Read-Field), 'yyyy-MM-ddTHH:mm:ss', [Globalization.CultureInfo]::InvariantCulture)
    $destination = Read-Field
    $script:cancelPath = Read-Field
    if (Test-Path -LiteralPath $script:cancelPath) { throw 'Cancelled' }
    # HCNetSDK ANSI output path: use a short directory name when available.
    if ($destination -match '[^\x00-\x7F]') {
        Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class ShortPath {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode)]
 public static extern uint GetShortPathName(string longPath, StringBuilder shortPath, uint size);
}
"@
        $parent = Split-Path -Parent $destination
        $buffer = New-Object Text.StringBuilder 32768
        $length = [ShortPath]::GetShortPathName($parent, $buffer, 32768)
        if ($length -eq 0 -or $buffer.ToString() -match '[^\x00-\x7F]') { throw 'ASCII_CACHE_REQUIRED' }
        $destination = Join-Path $buffer.ToString() (Split-Path -Leaf $destination)
    }
    Initialize-HikSdk -Directory $sdkDir
    $login = Login-HikDevice -Ip $deviceIp -Port $port -Username $username -Password $password
    $camera = [pscustomobject]@{ Name = 'clip'; Label = 'clip'; SdkChannel = $channel }
    $result = Download-Clip -UserId $login.UserId -Camera $camera -StartTime $start -EndTime $end -Destination $destination -TimeoutSeconds 3600
    Write-Host ('RESULT:' + $result.Status + ':' + $result.ErrorCode)
    if ($result.Status -ne 'ok') { exit 2 }
}
catch {
    # Never echo SDK input, credentials, or exception payloads.
    if (Test-Path -LiteralPath $script:cancelPath) { Write-Host 'RESULT:cancelled:' }
    elseif ($_.Exception.Message -eq 'ASCII_CACHE_REQUIRED') { Write-Host 'RESULT:ascii_cache_required:' }
    else {
        $sdkError = 0
        try { $sdkError = [HikvisionClipDownloader.HCNetSDK]::NET_DVR_GetLastError() } catch {}
        Write-Host ('RESULT:worker_failed:' + $sdkError)
    }
    exit 2
}
finally {
    $password = $null
    if ($login -and $login.UserId -ge 0) { [HikvisionClipDownloader.HCNetSDK]::NET_DVR_Logout($login.UserId) | Out-Null }
    try { [HikvisionClipDownloader.HCNetSDK]::NET_DVR_Cleanup() | Out-Null } catch {}
}
