# My Playlist — Windows 資料來源
# 每秒讀一次系統媒體佈告欄（SMTC），一行一筆 JSON 輸出給 Electron 主程序
# 需以 Windows PowerShell 5.1（powershell.exe）執行——PowerShell 7 拿掉了 WinRT 投影

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime

# WinRT 的非同步呼叫要靠 AsTask 橋接才能在 PowerShell 等待結果
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}

# 載入 WinRT 型別
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null

$manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])

$md5 = [System.Security.Cryptography.MD5]::Create()
$lastKey = ""
$lastArt = $null

while ($true) {
  try {
    $session = $manager.GetCurrentSession()
    if ($null -eq $session) {
      Write-Output '{"state":"stopped"}'
    } else {
      $props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
      $timeline = $session.GetTimelineProperties()
      $playback = $session.GetPlaybackInfo()

      $statusName = $playback.PlaybackStatus.ToString()
      if ($statusName -eq "Playing") { $state = "playing" }
      elseif ($statusName -eq "Paused") { $state = "paused" }
      else { $state = "stopped" }

      if ($state -eq "stopped") {
        Write-Output '{"state":"stopped"}'
      } else {
        $key = "$($props.Artist)|$($props.Title)"
        $id = ([System.BitConverter]::ToString($md5.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($key))) -replace '-', '').Substring(0, 16)

        # 縮圖：換歌時抽一次，存暫存檔
        if ($key -ne $lastKey) {
          $lastKey = $key
          $lastArt = $null
          if ($null -ne $props.Thumbnail) {
            try {
              $artPath = Join-Path ([System.IO.Path]::GetTempPath()) "my-playlist-art-$id.jpg"
              if (-not (Test-Path $artPath)) {
                $stream = Await ($props.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
                $size = $stream.Size
                $reader = New-Object Windows.Storage.Streams.DataReader($stream)
                Await ($reader.LoadAsync($size)) ([UInt32]) | Out-Null
                $bytes = New-Object byte[] $size
                $reader.ReadBytes($bytes)
                [System.IO.File]::WriteAllBytes($artPath, $bytes)
                $reader.Dispose(); $stream.Dispose()
              }
              $lastArt = $artPath
            } catch {
              [Console]::Error.WriteLine("thumbnail error: $_")
              $lastArt = $null
            }
          }
        }

        $out = @{
          state  = $state
          title  = [string]$props.Title
          artist = [string]$props.Artist
          pos    = [Math]::Round($timeline.Position.TotalSeconds, 1)
          dur    = [Math]::Round($timeline.EndTime.TotalSeconds, 1)
          id     = $id
          art    = $lastArt
        }
        Write-Output ($out | ConvertTo-Json -Compress)
      }
    }
  } catch {
    [Console]::Error.WriteLine("poll error: $_")
    Write-Output '{"state":"stopped"}'
  }
  Start-Sleep -Milliseconds 1000
}
