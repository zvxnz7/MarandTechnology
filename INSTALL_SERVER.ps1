param()

$ErrorActionPreference = 'Stop'
trap {
    $Failure = $_
    Write-Host "Instalator przerwany: $($Failure.Exception.Message)" -ForegroundColor Red
    if ($Failure.InvocationInfo.ScriptName -or $Failure.InvocationInfo.ScriptLineNumber) {
        $FailureScript = if ($Failure.InvocationInfo.ScriptName) { Split-Path -Leaf $Failure.InvocationInfo.ScriptName } else { 'INSTALL_SERVER.ps1' }
        Write-Host "Miejsce błędu: $FailureScript, wiersz $($Failure.InvocationInfo.ScriptLineNumber)" -ForegroundColor Yellow
    }
    if ($Failure.ScriptStackTrace) { Write-Host $Failure.ScriptStackTrace -ForegroundColor DarkYellow }
    Read-Host 'Naciśnij Enter, aby zamknąć instalator'
    exit 1
}
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
    $ElevatedProcess = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $Arguments -Wait -PassThru
    exit $ElevatedProcess.ExitCode
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
if ($VersionInfo.schema -ne 2 -or $VersionInfo.protocol -ne 2 -or !$VersionInfo.version) {
    throw 'release.json does not describe a supported app version.'
}

if (Test-Path -LiteralPath (Join-Path $DataDir 'marand.sqlite3')) {
    throw 'Istniejaca instalacja: uzyj procedury AKTUALIZACJA_SCHEMA2.txt. Instalator nie nadpisze programu z istniejaca baza.'
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

$ModulesDir = Join-Path $SourceRoot 'modules'
if (!(Test-Path -LiteralPath $ModulesDir -PathType Container)) { throw 'Brakuje katalogu modules w pobranym projekcie.' }
$ModuleFiles = @(Get-ChildItem -LiteralPath $ModulesDir -File -Filter '*.js' | Sort-Object Name)
if ($ModuleFiles.Count -eq 0 -or $ModuleFiles.Name -notcontains 'database.js' -or $ModuleFiles.Name -notcontains 'archive-cleanup.js') {
    throw 'Pobrany projekt jest niekompletny: wymagane moduły aplikacji nie są dostępne.'
}
$RuntimeFiles = @(
    'server.js','views.js','manage.js','package.json','schema.sql','NODE_SETUP.md','release.json',
    'static\app.css','static\app.js','static\card.css','static\logo.jpg','seed\data.json'
) + @($ModuleFiles | ForEach-Object { Join-Path 'modules' $_.Name })
foreach ($Relative in $RuntimeFiles) {
    $From = Join-Path $SourceRoot $Relative
    if (!(Test-Path -LiteralPath $From -PathType Leaf)) { throw "Brakuje pliku programu: $Relative" }
    $To = Join-Path $ProgramDir $Relative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $To) | Out-Null
    Copy-Item -LiteralPath $From -Destination $To -Force
}
foreach ($Relative in @('updater.js','control-server.ps1','run-server.ps1','set-github-token.ps1','backup_scheduled.ps1','wykonaj.ps1','AKTUALIZUJ.cmd','KOPIA.cmd','START_SERVER.cmd','STOP_SERVER.cmd','STATUS_SERVER.cmd','SET_GITHUB_TOKEN.cmd')) {
    $From = Join-Path (Join-Path $SourceRoot 'administracja') $Relative
    if (!(Test-Path -LiteralPath $From -PathType Leaf)) { throw "Brakuje pliku administracyjnego: administracja\$Relative" }
    Copy-Item -LiteralPath $From -Destination (Join-Path $AdminDir $Relative) -Force
}

$DatabasePath = Join-Path $DataDir 'marand.sqlite3'
if (!(Test-Path -LiteralPath $DatabasePath -PathType Leaf)) {
    $SourceDatabase = $null
    $BundledDatabase = Join-Path $SourceRoot 'data\marand.sqlite3'
    if (Test-Path -LiteralPath $BundledDatabase -PathType Leaf) {
        Write-Host 'W folderze instalatora znajduje się lokalna baza. Nie zostanie użyta bez podania jej ścieżki.' -ForegroundColor Yellow
    }
    $EnteredPath = Read-Host 'Jeśli chcesz zaimportować istniejącą bazę SQLite, wklej ścieżkę do marand.sqlite3. Enter tworzy nową bazę bez importu danych ani zdjęć'
    if (![string]::IsNullOrWhiteSpace($EnteredPath)) {
        $EnteredPath = [Environment]::ExpandEnvironmentVariables($EnteredPath.Trim().Trim('"').Trim("'"))
        try { $SourceDatabase = [IO.Path]::GetFullPath($EnteredPath) }
        catch { throw "Podana ścieżka do bazy ma nieprawidłowy format: $EnteredPath" }
        if (!(Test-Path -LiteralPath $SourceDatabase -PathType Leaf)) { throw "Nie znaleziono pliku bazy SQLite: $SourceDatabase" }
    }
    if ($SourceDatabase) {
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
    } else {
        Write-Host 'Pominięto import bazy i zdjęć. Instalator utworzy nową bazę.' -ForegroundColor Cyan
    }
}

$SettingsPath = Join-Path $AdminDir 'server-settings.json'
$Settings = [ordered]@{
    program_dir = $ProgramDir
    data_dir = $DataDir
    node_path = $NodePath
    host = '0.0.0.0'
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
$AdminTraverseAcl = & icacls.exe $AdminDir /grant '*S-1-5-32-545:(X)'
if ($LASTEXITCODE -ne 0) { throw 'Could not allow users to launch the standalone updater.' }
foreach ($Launcher in @('AKTUALIZUJ.cmd','wykonaj.ps1')) {
    $LauncherAcl = & icacls.exe (Join-Path $AdminDir $Launcher) /grant '*S-1-5-32-545:(RX)'
    if ($LASTEXITCODE -ne 0) { throw "Could not allow users to launch $Launcher." }
}
$BackupAcl = & icacls.exe $BackupDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F'
if ($LASTEXITCODE -ne 0) { throw 'Could not restrict access to the backup folder.' }

if (!(Test-Path -LiteralPath $DatabasePath -PathType Leaf)) { Write-Host 'First run: create the app administrator account.' }
$env:MARAND_DATA = $DataDir
try {
    & $NodePath (Join-Path $ProgramDir 'manage.js') init
    if ($LASTEXITCODE -ne 0) { throw 'Database initialization failed.' }
} finally { Remove-Item Env:\MARAND_DATA -ErrorAction SilentlyContinue }

Write-Host 'Repozytorium GitHub jest publiczne. Token nie jest potrzebny.' -ForegroundColor Green

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

# Permit access only from the local subnet on Private or authenticated Domain networks.
# Do not open this port on Public networks or to the public Internet.
$FirewallRuleName = 'MarandTechnologia-LAN-8765'
Get-NetFirewallRule -Name $FirewallRuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -Name $FirewallRuleName `
    -DisplayName 'Marand Technologia (private LAN only)' `
    -Description 'Allows TCP 8765 only from the local subnet on Private or Domain network profiles.' `
    -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8765 `
    -Profile Private,Domain -RemoteAddress LocalSubnet -EdgeTraversalPolicy Block | Out-Null

Remove-Item -LiteralPath (Join-Path $AdminDir 'stop.request') -Force -ErrorAction SilentlyContinue
Write-Host 'Uruchamiam aplikację jako zadanie Windows...' -ForegroundColor Cyan
Start-ScheduledTask -TaskName $TaskName
$HealthUrl = 'http://127.0.0.1:8765/healthz'
$ExpectedDataDir = [IO.Path]::GetFullPath($DataDir).ToLowerInvariant()
$DataTagHasher = [Security.Cryptography.SHA256]::Create()
try {
    $ExpectedDataTag = [BitConverter]::ToString($DataTagHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($ExpectedDataDir))).Replace('-','').ToLowerInvariant()
} finally { $DataTagHasher.Dispose() }
$Deadline = (Get-Date).AddSeconds(45)
$Healthy = $false
Write-Host 'Sprawdzam uruchomienie aplikacji (maksymalnie 45 sekund)...' -ForegroundColor Cyan
while ((Get-Date) -lt $Deadline) {
    try {
        $Health = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 2
        if ($Health.ok -and $Health.version -eq $VersionInfo.version -and $Health.data_tag -eq $ExpectedDataTag) { $Healthy = $true; break }
    } catch { Start-Sleep -Seconds 1 }
}
if (!$Healthy) {
    $LogDir = Join-Path $AdminDir 'logs'
    Write-Warning "Aplikacja nie odpowiedziała. Najnowszy log błędów: $LogDir"
    $LatestErrorLog = Get-ChildItem -LiteralPath $LogDir -Filter 'server-*.err.log' -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($LatestErrorLog) {
        Write-Host "Ostatni komunikat serwera ($($LatestErrorLog.Name)):" -ForegroundColor Yellow
        Get-Content -LiteralPath $LatestErrorLog.FullName -Tail 30
    }
    throw 'Konfiguracja została zapisana, ale aplikacja nie przeszła kontroli uruchomienia. Zachowaj log powyżej i nie usuwaj katalogu dane.'
} else {
    Write-Host 'The app is running in the background and will start with Windows.' -ForegroundColor Green
}

Write-Host ''
$LanAddresses = @()
$UpInterfaceIndexes = @(Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object Status -eq 'Up' | Select-Object -ExpandProperty ifIndex)
if ($UpInterfaceIndexes.Count -gt 0) {
    $LanAddresses = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object {
            $_.InterfaceIndex -in $UpInterfaceIndexes -and $_.AddressState -eq 'Preferred' -and
            ($_.IPAddress -match '^10\.' -or $_.IPAddress -match '^192\.168\.' -or $_.IPAddress -match '^172\.(1[6-9]|2\d|3[01])\.')
        } |
        Select-Object -ExpandProperty IPAddress -Unique)
}
Write-Host 'On the server: http://127.0.0.1:8765'
if ($LanAddresses.Count -gt 0) {
    Write-Host 'From another computer on the same local subnet:'
    foreach ($Address in $LanAddresses) { Write-Host "  http://${Address}:8765" -ForegroundColor Green }
} else {
    Write-Host 'Could not find a LAN IPv4 address. Run ipconfig on the server to find it.' -ForegroundColor Yellow
}
Write-Host "Data: $DataDir"
Write-Host "Backups: $BackupDir (daily at 22:00)"
Write-Host "Update page: repo $Repo; GitHub Actions publishes an update after each push to main."
Write-Host "Standalone GitHub updater: $(Join-Path $AdminDir 'AKTUALIZUJ.cmd')"
Write-Host 'LAN access is limited by Windows Firewall to the LocalSubnet on Private or Domain network profiles.'
Write-Host 'Use only on a trusted LAN; do not forward TCP 8765 from your router to the Internet.'
Write-Host ''
Read-Host 'Press Enter to close'
