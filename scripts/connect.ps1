# Connects scrcpy to a running redroid-forge instance, picked from a menu built from the
# real API (GET /api/instances) instead of copying a port by hand every time.
#
# Requires: adb and scrcpy (https://github.com/Genymobile/scrcpy) on PATH. Neither is
# bundled here. If scrcpy itself gives you trouble (audio, hardware decode, bitrate), see
# docs/SCRCPY-TIPS.md.
#
# Usage:   powershell -File scripts\connect.ps1
# Env vars (set with $env:NAME = "..." before running, or inline: $env:X="..."; .\connect.ps1):
#   REDROID_FORGE_URL   Base URL of redroid-forge's API. Default: http://localhost:8080
#   REDROID_FORGE_HOST  Host/IP to actually adb-connect/scrcpy to, if different from the
#                       host in REDROID_FORGE_URL. Default: derived from REDROID_FORGE_URL.
#   SCRCPY_EXTRA_ARGS   Extra scrcpy flags appended as-is, e.g. "--hwdec=disabled".

$ForgeUrl = if ($env:REDROID_FORGE_URL) { $env:REDROID_FORGE_URL } else { "http://localhost:8080" }
$StateDir = Join-Path $HOME ".config\redroid-forge-connect"
$StateFile = Join-Path $StateDir "state.json"
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

foreach ($bin in @("adb", "scrcpy")) {
    if (-not (Get-Command $bin -ErrorAction SilentlyContinue)) {
        Write-Error "Missing dependency: $bin (not found on PATH)"
        exit 1
    }
}

$TargetHost = if ($env:REDROID_FORGE_HOST) { $env:REDROID_FORGE_HOST } else { ([uri]$ForgeUrl).Host }

$Instances = @()
try {
    $resp = Invoke-RestMethod -Uri "$ForgeUrl/api/instances" -TimeoutSec 5
    $Instances = @($resp | Where-Object { $_.status -eq "running" })
} catch {
    Write-Warning "Could not reach $ForgeUrl/api/instances ($($_.Exception.Message))."
    Write-Host "Set REDROID_FORGE_URL if redroid-forge is not on this machine, e.g.:"
    Write-Host '  $env:REDROID_FORGE_URL = "http://192.168.1.50:8080"; .\connect.ps1'
}

$UsbLabel = "USB device (this PC)"
$Options = @($Instances | ForEach-Object { $_.name }) + $UsbLabel

$LastDevice = $null
$LastBitrate = "default (8M)"
if (Test-Path $StateFile) {
    $state = Get-Content $StateFile -Raw | ConvertFrom-Json
    $LastDevice = $state.LastDevice
    $LastBitrate = $state.LastBitrate
}

function Choose($Prompt, $Default, $Opts) {
    for ($i = 0; $i -lt $Opts.Count; $i++) {
        $mark = if ($Opts[$i] -eq $Default) { " (default)" } else { "" }
        Write-Host ("  {0}) {1}{2}" -f ($i + 1), $Opts[$i], $mark)
    }
    $sel = Read-Host $Prompt
    if ([string]::IsNullOrWhiteSpace($sel) -and $Default) { $sel = [string]([array]::IndexOf($Opts, $Default) + 1) }
    $idx = 0
    if (-not [int]::TryParse($sel, [ref]$idx) -or $idx -lt 1 -or $idx -gt $Opts.Count) { return $null }
    return $Opts[$idx - 1]
}

Write-Host ""
Write-Host "Instances:"
$Selected = Choose "Pick one: " $LastDevice $Options
if (-not $Selected) { Write-Error "Invalid selection."; exit 1 }

if ($Selected -eq $UsbLabel) {
    $usbLines = (adb devices -l 2>$null) -split "`n" | Select-Object -Skip 1
    $UsbDevices = @()
    foreach ($line in $usbLines) {
        $tokens = $line -split '\s+' | Where-Object { $_ }
        if ($tokens.Count -ge 2 -and $tokens[1] -eq "device" -and $tokens[0] -notmatch ':') {
            $UsbDevices += $tokens[0]
        }
    }
    if ($UsbDevices.Count -eq 0) { Write-Error "No USB devices found (adb devices found none)."; exit 1 }
    Write-Host "USB devices:"
    $Target = Choose "Pick one: " $null $UsbDevices
    if (-not $Target) { Write-Error "Invalid selection."; exit 1 }
} else {
    $inst = $Instances | Where-Object { $_.name -eq $Selected } | Select-Object -First 1
    $Target = "${TargetHost}:$($inst.adbPort)"
    adb connect $Target | Out-Null
}

Write-Host ""
Write-Host "Video bit rate:"
$BitrateOpts = @("default (8M)", "4M", "2M", "1M")
$Bitrate = Choose "Pick one: " $LastBitrate $BitrateOpts
if (-not $Bitrate) { $Bitrate = "default (8M)" }

@{ LastDevice = $Selected; LastBitrate = $Bitrate } | ConvertTo-Json | Set-Content $StateFile

# --audio-codec=aac: redroid has no Opus encoder, and opus is scrcpy's default -- without
# this, audio silently fails. See docs/SCRCPY-TIPS.md for this and other first-run gotchas.
$ScrcpyArgs = @("-s", $Target, "--audio-codec=aac")
if ($Bitrate -ne "default (8M)") { $ScrcpyArgs += "--video-bit-rate=$Bitrate" }
if ($env:SCRCPY_EXTRA_ARGS) { $ScrcpyArgs += ($env:SCRCPY_EXTRA_ARGS -split '\s+') }

& scrcpy @ScrcpyArgs
