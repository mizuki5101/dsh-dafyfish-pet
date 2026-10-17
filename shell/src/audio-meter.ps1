param([int]$ParentPid = 0, [switch]$PlayTest, [int]$Ticks = 0)
$ErrorActionPreference = 'Stop'

# 默认播放设备（eRender / eMultimedia）的峰值表。
# 不读音频内容、不读标题，只拿一个 0~1 的 peak —— 用户在设置里可以整个关掉。
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
public class MMDeviceEnumeratorComObject { }

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceEnumerator {
    int NotImpl1();
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDevice {
    int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
}

[ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioMeterInformation {
    int GetPeakValue(out float pfPeak);
}

public static class AudioPeak {
    static IAudioMeterInformation meter;
    public static void Init() {
        var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
        IMMDevice dev;
        int hr = enumerator.GetDefaultAudioEndpoint(0, 1, out dev);
        if (hr != 0) throw new COMException("GetDefaultAudioEndpoint", hr);
        Guid iid = typeof(IAudioMeterInformation).GUID;
        object obj;
        hr = dev.Activate(ref iid, 0, IntPtr.Zero, out obj);
        if (hr != 0) throw new COMException("Activate", hr);
        meter = (IAudioMeterInformation)obj;
    }
    public static float Get() {
        if (meter == null) Init();
        float peak;
        int hr = meter.GetPeakValue(out peak);
        if (hr != 0) throw new COMException("GetPeakValue", hr);
        return peak;
    }
}
"@

try { [AudioPeak]::Init() } catch {
  [Console]::WriteLine('ERR ' + $_.Exception.Message)
  [Console]::Out.Flush()
  exit 1
}
try { [System.Diagnostics.Process]::GetCurrentProcess().PriorityClass = 'BelowNormal' } catch {}
[Console]::WriteLine('READY')
[Console]::Out.Flush()

if ($PlayTest) {
  $wav = 'C:\Windows\Media\Alarm01.wav'
  if (-not (Test-Path $wav)) { $wav = Get-ChildItem 'C:\Windows\Media\*.wav' | Select-Object -First 1 -ExpandProperty FullName }
  if ($wav) {
    [Console]::WriteLine('PLAY ' + $wav)
    [Console]::Out.Flush()
    $player = New-Object System.Media.SoundPlayer $wav
    $player.Play()
  }
}

$i = 0
while ($true) {
  try { $p = [AudioPeak]::Get() } catch {
    [Console]::WriteLine('ERR ' + $_.Exception.Message)
    [Console]::Out.Flush()
    break
  }
  [Console]::WriteLine('PEAK ' + $p.ToString('0.0000', [Globalization.CultureInfo]::InvariantCulture))
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 250
  $i++
  if ($Ticks -gt 0 -and $i -ge $Ticks) { break }
  # 每 10 秒确认一次父进程还在：外壳崩了不要留一个孤儿 PowerShell
  if ($ParentPid -gt 0 -and ($i % 40) -eq 0) {
    try { $null = Get-Process -Id $ParentPid -ErrorAction Stop } catch { break }
  }
}
