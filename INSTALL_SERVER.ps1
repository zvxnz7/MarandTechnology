param()

$ErrorActionPreference = 'Stop'
$SourceRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$InstallRoot = 'C:\Marand\Technologia'
$ProgramDir = Join-Path $InstallRoot 'program'
$DataDir = Join-Path $InstallRoot 'dane'
$AdminDir = Join-Path $InstallRoot 'administracja'
$ReleaseDir = Join-Path $InstallRoot 'poprzednie_wersje'
$TaskName = 'MarandTechnologia'
$BackupTaskName = 'MarandTechnologiaBackup'
$Repo = 'zvxnz7/MarandTechnology'

function Test-IsAdministrator {
    $Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $Principal = New-Object Security.Principal.WindowsPrincipal($Identity)
    return $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (!(Test-IsAdministrator)) {
    $Arguments = '-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $PSCommandPath
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $Arguments
    exit
}

foreach ($Required in @('server.js','manage.js','release.json','tools\build-release.js')) {
    if (!(Test-Path -LiteralPath (Join-Path $SourceRoot $Required) -PathType Leaf)) {
        throw "Run INSTALL_SERVER.cmd from the project root folder. Missing: $Required"
    }
}

function Find-Node {
    $Command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($Command) { return $Command.Source }
    foreach ($Candidate in @((Join-Path $env:ProgramFiles 'nodejs\node.exe'),(Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'))) {
        if ($Candidate -and (Test-Path -LiteralPath $Candidate -PathType Leaf)) { return $Candidate }
    }
    return $null
}

function Test-NodeVersion([string]$NodePath) {
    if (!$NodePath) { return $false }
    $VersionText = [string](& $NodePath --version 2>$null)
    if ([string]::IsNullOrWhiteSpace($VersionText)) { return $false }
    $VersionText = $VersionText.Trim()
    if ($VersionText -notmatch '^v?(\d+)\.(\d+)\.(\d+)') { return $false }
    $Version = [version]::new([int]$Matches[1],[int]$Matches[2],[int]$Matches[3])
    return ($Version.Major -gt 24 -or ($Version.Major -eq 24 -and $Version.Minor -ge 15))
}

$NodePath = Find-Node
if (!(Test-NodeVersion $NodePath)) {
    $Winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if ($Winget) {
        Write-Host 'Installing or updating Node.js LTS with winget...'
        & $Winget.Source install --id OpenJS.NodeJS.LTS --exact --source winget --accept-package-agreements --accept-source-agreements --disable-interactivity
        $NodePath = Find-Node
        if (!(Test-NodeVersion $NodePath)) {
            & $Winget.Source upgrade --id OpenJS.NodeJS.LTS --exact --source winget --accept-package-agreements --accept-source-agreements --disable-interactivity
            $NodePath = Find-Node
        }
    }
}
if (!(Test-NodeVersion $NodePath)) {
    throw 'Node.js 24.15 or newer is required. Install the official Node.js LTS runtime, then run this installer again and check node --version.'
}

$VersionInfo = Get-Content -LiteralPath (Join-Path $SourceRoot 'release.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($VersionInfo.schema -ne 1 -or $VersionInfo.protocol -ne 2 -or !$VersionInfo.version) {
    throw 'release.json does not describe a supported app version.'
}

$BackupDir = if (Test-Path -LiteralPath 'D:\' -PathType Container) { 'D:\Kopie\Marand-Technologia' } else { Join-Path $InstallRoot 'kopie' }
foreach ($Directory in @($InstallRoot,$ProgramDir,$DataDir,$AdminDir,$ReleaseDir,$BackupDir)) {
    New-Item -ItemType Directory -Force -Path $Directory | Out-Null
}

$TaskExists = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($TaskExists -and $TaskExists.State -eq 'Running') {
    Write-Host 'Stopping the current app before copying program files...'
    & (Join-Path $AdminDir 'control-server.ps1') -Action stop -ConfigPath (Join-Path $AdminDir 'konfiguracja.json')
}

$RuntimeFiles = @(
    'server.js','views.js','manage.js','package.json','schema.sql','NODE_SETUP.md','release.json',
    'static\app.css','static\app.js','static\card.css','static\logo.jpg','seed\data.json'
)
foreach ($Relative in $RuntimeFiles) {
    $From = Join-Path $SourceRoot $Relative
    if (!(Test-Path -LiteralPath $From -PathType Leaf)) { throw "Brakuje pliku programu: $Relative" }
    $To = Join-Path $ProgramDir $Relative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $To) | Out-Null
    Copy-Item -LiteralPath $From -Destination $To -Force
}
$SourceAssets = Join-Path $SourceRoot 'seed\sources'
if (Test-Path -LiteralPath $SourceAssets -PathType Container) {
    Copy-Item -LiteralPath $SourceAssets -Destination (Join-Path $ProgramDir 'seed') -Recurse -Force
}

foreach ($Relative in @('updater.js','control-server.ps1','run-server.ps1','set-github-token.ps1','backup_scheduled.ps1','wykonaj.ps1','KOPIA.cmd','START_SERVER.cmd','STOP_SERVER.cmd','STATUS_SERVER.cmd','SET_GITHUB_TOKEN.cmd')) {
    $From = Join-Path (Join-Path $SourceRoot 'administracja') $Relative
    if (!(Test-Path -LiteralPath $From -PathType Leaf)) { throw "Brakuje pliku administracyjnego: administracja\$Relative" }
    Copy-Item -LiteralPath $From -Destination (Join-Path $AdminDir $Relative) -Force
}

$DatabasePath = Join-Path $DataDir 'marand.sqlite3'
if (!(Test-Path -LiteralPath $DatabasePath -PathType Leaf)) {
    $SourceDatabase = Join-Path $SourceRoot 'data\marand.sqlite3'
    if (!(Test-Path -LiteralPath $SourceDatabase -PathType Leaf)) {
        $EnteredPath = Read-Host 'If you already have a SQLite database, enter the path to marand.sqlite3. Press Enter to create a new seeded database'
        if (![string]::IsNullOrWhiteSpace($EnteredPath)) { $SourceDatabase = [IO.Path]::GetFullPath($EnteredPath) }
    }
    if (Test-Path -LiteralPath $SourceDatabase -PathType Leaf) {
        Write-Host 'Creating a consistent copy of the selected database...'
        $env:MARAND_DATA = Split-Path -Parent $SourceDatabase
        $env:MARAND_DATABASE = $SourceDatabase
        try {
            & $NodePath (Join-Path $ProgramDir 'manage.js') backup --output $DatabasePath
            if ($LASTEXITCODE -ne 0) { throw 'Database backup failed.' }
        } finally {
            Remove-Item Env:\MARAND_DATA -ErrorAction SilentlyContinue
            Remove-Item Env:\MARAND_DATABASE -ErrorAction SilentlyContinue
        }
        $SourceSecret = Join-Path (Split-Path -Parent $SourceDatabase) 'secret.key'
        if (Test-Path -LiteralPath $SourceSecret -PathType Leaf) {
            Copy-Item -LiteralPath $SourceSecret -Destination (Join-Path $DataDir 'secret.key') -Force
        }
    }
}

$SettingsPath = Join-Path $AdminDir 'server-settings.json'
$Settings = [ordered]@{
    program_dir = $ProgramDir
    data_dir = $DataDir
    node_path = $NodePath
    host = '127.0.0.1'
    port = 8765
    https = $false
    github_repo = $Repo
}
[IO.File]::WriteAllText($SettingsPath, ($Settings | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))

$UpdaterConfigPath = Join-Path $AdminDir 'konfiguracja.json'
$UpdaterConfig = [ordered]@{
    program_dir = $ProgramDir
    data_dir = $DataDir
    backup_dir = $BackupDir
    releases_dir = $ReleaseDir
    service_name = $TaskName
    service_type = 'scheduled-task'
    node_path = $NodePath
    health_url = 'http://127.0.0.1:8765/healthz'
    daily_keep = 14
}
[IO.File]::WriteAllText($UpdaterConfigPath, ($UpdaterConfig | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))

$DataAcl = & icacls.exe $DataDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F'
if ($LASTEXITCODE -ne 0) { throw 'Could not restrict access to the data folder.' }
$AdminAcl = & icacls.exe $AdminDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F'
if ($LASTEXITCODE -ne 0) { throw 'Could not restrict access to the administration folder.' }
$BackupAcl = & icacls.exe $BackupDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F'
if ($LASTEXITCODE -ne 0) { throw 'Could not restrict access to the backup folder.' }

if (!(Test-Path -LiteralPath $DatabasePath -PathType Leaf)) { Write-Host 'First run: create the app administrator account.' }
$env:MARAND_DATA = $DataDir
try {
    & $NodePath (Join-Path $ProgramDir 'manage.js') init
    if ($LASTEXITCODE -ne 0) { throw 'Database initialization failed.' }
} finally { Remove-Item Env:\MARAND_DATA -ErrorAction SilentlyContinue }

$SecureToken = Read-Host 'Optional: paste a fine-grained GitHub token with Contents: Read-only access to this private repo (Enter skips for now)' -AsSecureString
$TokenCredential = New-Object -TypeName System.Net.NetworkCredential -ArgumentList @('', $SecureToken)
$Token = $TokenCredential.Password
if (![string]::IsNullOrWhiteSpace($Token)) {
    Add-Type -AssemblyName System.Security
    $TokenBytes = [Text.Encoding]::UTF8.GetBytes($Token)
    $ProtectedToken = [Security.Cryptography.ProtectedData]::Protect(
        $TokenBytes, $null, [Security.Cryptography.DataProtectionScope]::LocalMachine
    )
    [IO.File]::WriteAllBytes((Join-Path $AdminDir 'github-token.dpapi'), $ProtectedToken)
    [Array]::Clear($TokenBytes, 0, $TokenBytes.Length)
    $Token = $null
    $TokenCredential = $null
}

$PowerShell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$RunScript = Join-Path $AdminDir 'run-server.ps1'
$TaskAction = New-ScheduledTaskAction -Execute $PowerShell -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}"' -f $RunScript) -WorkingDirectory $AdminDir
$StartupTrigger = New-ScheduledTaskTrigger -AtStartup
$Principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$ServiceSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $TaskName -Action $TaskAction -Trigger $StartupTrigger -Principal $Principal -Settings $ServiceSettings -Description 'Marand Technologia Node.js web application' -Force | Out-Null

$BackupScript = Join-Path $AdminDir 'backup_scheduled.ps1'
& $BackupScript -ConfigPath $UpdaterConfigPath
if ($LASTEXITCODE -ne 0) { throw 'The first database backup failed. The daily backup task was not installed.' }
$BackupAction = New-ScheduledTaskAction -Execute $PowerShell -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -ConfigPath "{1}"' -f $BackupScript,$UpdaterConfigPath) -WorkingDirectory $AdminDir
$BackupTrigger = New-ScheduledTaskTrigger -Daily -At '22:00'
$BackupSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 15) -ExecutionTimeLimit (New-TimeSpan -Hours 2)
Register-ScheduledTask -TaskName $BackupTaskName -Action $BackupAction -Trigger $BackupTrigger -Principal $Principal -Settings $BackupSettings -Description 'Marand Technologia daily SQLite backup' -Force | Out-Null

Remove-Item -LiteralPath (Join-Path $AdminDir 'stop.request') -Force -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName $TaskName
$HealthUrl = 'http://127.0.0.1:8765/healthz'
$Deadline = (Get-Date).AddSeconds(45)
$Healthy = $false
while ((Get-Date) -lt $Deadline) {
    try {
        $Health = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 2
        if ($Health.ok) { $Healthy = $true; break }
    } catch { Start-Sleep -Seconds 1 }
}
if (!$Healthy) {
    Write-Warning "The app has not responded yet. Check logs: $(Join-Path $AdminDir 'logs')"
} else {
    Write-Host 'The app is running in the background and will start with Windows.' -ForegroundColor Green
}

Write-Host ''
Write-Host 'Server address: http://127.0.0.1:8765'
Write-Host "Data: $DataDir"
Write-Host "Backups: $BackupDir (daily at 22:00)"
Write-Host "Update page: repo $Repo; releases require a vX.Y.Z tag."
if (!(Test-Path -LiteralPath (Join-Path $AdminDir 'github-token.dpapi'))) {
    Write-Host 'Private repo token was skipped. The update page cannot read releases until a token is configured.' -ForegroundColor Yellow
}
Write-Host 'The app is only available on this server. Configure HTTPS or a trusted VPN before accessing it from other devices.'
Write-Host ''
Read-Host 'Press Enter to close'
