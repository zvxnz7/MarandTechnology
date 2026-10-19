$ErrorActionPreference = 'Stop'
$ConfigPath = Join-Path $PSScriptRoot 'server-settings.json'
$Cfg = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$Program = [IO.Path]::GetFullPath([string]$Cfg.program_dir)
$Data = [IO.Path]::GetFullPath([string]$Cfg.data_dir)
$Node = [IO.Path]::GetFullPath([string]$Cfg.node_path)
$NodeScript = Join-Path $Program 'manage.js'
$StopFile = Join-Path $PSScriptRoot 'stop.request'
$PidFile = Join-Path $PSScriptRoot 'server.pid'
$Logs = Join-Path $PSScriptRoot 'logs'

if (Test-Path -LiteralPath $StopFile) { exit 0 }
if (!(Test-Path -LiteralPath $Node -PathType Leaf)) { throw "Nie znaleziono Node.js: $Node" }
if (!(Test-Path -LiteralPath $NodeScript -PathType Leaf)) { throw "Nie znaleziono aplikacji: $NodeScript" }
New-Item -ItemType Directory -Force -Path $Logs | Out-Null

$env:MARAND_DATA = $Data
$env:MARAND_HOST = [string]$Cfg.host
$env:MARAND_PORT = [string]$Cfg.port
$env:MARAND_HTTPS = if ($Cfg.https) { '1' } else { '0' }
$env:MARAND_GITHUB_REPO = [string]$Cfg.github_repo
$env:MARAND_UPDATER = Join-Path $PSScriptRoot 'updater.js'
$env:MARAND_UPDATE_CONFIG = Join-Path $PSScriptRoot 'konfiguracja.json'
$TokenPath = Join-Path $PSScriptRoot 'github-token.dpapi'
if (Test-Path -LiteralPath $TokenPath) {
    Add-Type -AssemblyName System.Security
    $Protected = [IO.File]::ReadAllBytes($TokenPath)
    $TokenBytes = [Security.Cryptography.ProtectedData]::Unprotect(
        $Protected, $null, [Security.Cryptography.DataProtectionScope]::LocalMachine
    )
    $env:MARAND_GITHUB_TOKEN = [Text.Encoding]::UTF8.GetString($TokenBytes)
}

$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$OutLog = Join-Path $Logs "server-$Stamp.out.log"
$ErrLog = Join-Path $Logs "server-$Stamp.err.log"
$Process = Start-Process -FilePath $Node -ArgumentList @($NodeScript,'run','--host',$env:MARAND_HOST,'--port',$env:MARAND_PORT) `
    -WorkingDirectory $Program -PassThru -NoNewWindow -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog
[IO.File]::WriteAllText($PidFile, [string]$Process.Id, [Text.UTF8Encoding]::new($false))
try {
    $Process.WaitForExit()
    $ExitCode = $Process.ExitCode
} finally {
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
}

if (Test-Path -LiteralPath $StopFile) { exit 0 }
exit $ExitCode
