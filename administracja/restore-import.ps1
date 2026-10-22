param(
    [Parameter(Mandatory=$true)][string]$ConfigPath,
    [Parameter(Mandatory=$true)][string]$BackupPath,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$PackageHash
)

$ErrorActionPreference = 'Stop'
$TranscriptStarted = $false
$Lock = $null
$LockCreated = $false
$LockToken = [guid]::NewGuid().ToString('N')
$TaskStopped = $false
$TaskStartAttempted = $false
$MaintenancePath = $null
$StatusPath = $null
$RollbackPath = $null

function Write-RestoreStatus([bool]$Ok, [string]$ErrorMessage = '') {
    if (!$StatusPath) { return }
    $Value = [ordered]@{
        ok = $Ok
        at = (Get-Date).ToUniversalTime().ToString('o')
        package_hash = $PackageHash
        rollback_name = if ($RollbackPath) { Split-Path -Leaf $RollbackPath } else { '' }
        error = $ErrorMessage
    }
    $Temporary = $StatusPath + '.tmp'
    [IO.File]::WriteAllText($Temporary, ($Value | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $Temporary -Destination $StatusPath -Force
}

function Invoke-Node([string[]]$Arguments) {
    & $Node @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Polecenie manage.js zakończyło się błędem $LASTEXITCODE." }
}

function Invoke-Control([string]$Action) {
    & $PowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $Controller -Action $Action -ConfigPath $ConfigPath
    if ($LASTEXITCODE -ne 0) { throw "Nie udało się $Action zadania serwera (kod $LASTEXITCODE)." }
}

function Test-DatabaseSnapshot {
    try {
        Invoke-Node @('verify-snapshot','--input',$DatabasePath,'--photos',(Join-Path $Data 'photos'))
        return $true
    } catch { return $false }
}

function Wait-Health {
    $Deadline = (Get-Date).AddSeconds(60)
    do {
        try {
            $Response = Invoke-WebRequest -UseBasicParsing -Uri $HealthUrl -TimeoutSec 3
            $Health = $Response.Content | ConvertFrom-Json
            if ($Response.StatusCode -eq 200 -and $Health.ok -eq $true) { return }
        } catch {}
        Start-Sleep -Milliseconds 750
    } while ((Get-Date) -lt $Deadline)
    throw 'Serwer nie przeszedł kontroli uruchomienia po przywróceniu.'
}

try {
    $ResolvedConfigPath = [IO.Path]::GetFullPath($ConfigPath)
    if (!(Test-Path -LiteralPath $ResolvedConfigPath -PathType Leaf)) { throw 'Nie znaleziono konfiguracji serwera.' }
    $Cfg = Get-Content -LiteralPath $ResolvedConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($Cfg.service_type -ne 'scheduled-task' -or !$Cfg.service_name) { throw 'Automatyczne przywracanie wymaga serwera uruchomionego jako zadanie Windows.' }

    $Program = [IO.Path]::GetFullPath([string]$Cfg.program_dir)
    $Data = [IO.Path]::GetFullPath([string]$Cfg.data_dir)
    $BackupRoot = [IO.Path]::GetFullPath([string]$Cfg.backup_dir)
    $Backup = [IO.Path]::GetFullPath($BackupPath)
    $ExpectedImportBackupDir = [IO.Path]::GetFullPath((Join-Path $BackupRoot 'przed_importem'))
    if ((Split-Path -Parent $Backup) -ine $ExpectedImportBackupDir -or (Split-Path -Leaf $Backup) -notmatch '^IMPORT-\d{17}\.sqlite3$') {
        throw 'Ścieżka kopii sprzed importu jest nieprawidłowa.'
    }

    $AdminDir = Split-Path -Parent $ResolvedConfigPath
    $SettingsPath = Join-Path $AdminDir 'server-settings.json'
    $Settings = Get-Content -LiteralPath $SettingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $Node = [IO.Path]::GetFullPath([string]$Cfg.node_path)
    if (!(Test-Path -LiteralPath $Node -PathType Leaf)) { $Node = [IO.Path]::GetFullPath([string]$Settings.node_path) }
    if (!(Test-Path -LiteralPath $Node -PathType Leaf)) { throw 'Nie znaleziono node.exe z konfiguracji serwera.' }
    $Manage = Join-Path $Program 'manage.js'
    $Controller = Join-Path $AdminDir 'control-server.ps1'
    $PowerShell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $DatabasePath = Join-Path $Data 'marand.sqlite3'
    $MaintenancePath = Join-Path $Data 'maintenance.json'
    $StatusPath = Join-Path $Data 'import_restore_status.json'
    $HealthUrl = [string]$Cfg.health_url
    if (!$HealthUrl) { $HealthUrl = 'http://127.0.0.1:8765/healthz' }

    foreach ($RequiredPath in @($Manage,$Controller,$PowerShell)) {
        if (!(Test-Path -LiteralPath $RequiredPath -PathType Leaf)) { throw "Brakuje wymaganego pliku: $RequiredPath" }
    }
    if (!(Test-Path -LiteralPath $MaintenancePath -PathType Leaf)) { throw 'Brak blokady serwera. Uruchom przywracanie ponownie z aplikacji.' }

    $LogDir = Join-Path $AdminDir 'logs'
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
    $LogPath = Join-Path $LogDir ('restore-import-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.log')
    Start-Transcript -LiteralPath $LogPath -Force | Out-Null
    $TranscriptStarted = $true

    $env:MARAND_DATA = $Data
    $env:MARAND_DATABASE = $DatabasePath
    $env:MARAND_UPDATE_CONFIG = $ResolvedConfigPath

    $OperationsLock = Join-Path $Data 'operations.lock'
    $Lock = [IO.File]::Open($OperationsLock,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    $LockCreated = $true
    $LockContents = @{ pid = $PID; token = $LockToken; operation = 'source-import-restore'; started_at = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress
    $LockBytes = [Text.Encoding]::UTF8.GetBytes($LockContents)
    $Lock.Write($LockBytes,0,$LockBytes.Length)
    $Lock.Flush($true)
    $Lock.Dispose()
    $Lock = $null

    Invoke-Node @('verify-snapshot','--input',$Backup,'--absent-import-hash',$PackageHash)
    $RollbackDir = Join-Path $BackupRoot 'przed_przywroceniem'
    New-Item -ItemType Directory -Force -Path $RollbackDir | Out-Null
    $RollbackPath = Join-Path $RollbackDir ('PO-IMPORT-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.sqlite3')

    Write-Host 'Tworzenie i kontrola kopii obecnego stanu...'
    Invoke-Node @('backup','--output',$RollbackPath)
    Invoke-Node @('verify-snapshot','--input',$RollbackPath)

    $Maintenance = Get-Content -LiteralPath $MaintenancePath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($Maintenance.operation -ne 'source-import-restore' -or $Maintenance.package_hash -ne $PackageHash) {
        throw 'Blokada przywracania zmieniła się podczas przygotowania kopii.'
    }
    $Maintenance | Add-Member -NotePropertyName rollback_path -NotePropertyValue $RollbackPath -Force
    $MaintenanceTemp = $MaintenancePath + '.tmp'
    [IO.File]::WriteAllText($MaintenanceTemp, ($Maintenance | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $MaintenanceTemp -Destination $MaintenancePath -Force

    Write-Host 'Zatrzymywanie serwera...'
    Invoke-Control 'stop'
    $TaskStopped = $true

    Write-Host 'Przywracanie bazy i zdjęć z kopii sprzed importu...'
    Invoke-Node @('restore-snapshot','--input',$Backup,'--rollback',$RollbackPath,'--absent-import-hash',$PackageHash)
    Invoke-Node @('verify-snapshot','--input',$DatabasePath,'--photos',(Join-Path $Data 'photos'),'--absent-import-hash',$PackageHash)

    Write-Host 'Uruchamianie serwera i kontrola działania...'
    $TaskStartAttempted = $true
    Invoke-Control 'start'
    $TaskStopped = $false
    Wait-Health
    Remove-Item -LiteralPath $MaintenancePath -Force -ErrorAction SilentlyContinue
    Write-RestoreStatus $true ''
    Write-Host 'Przywracanie zakończyło się powodzeniem.'
} catch {
    $Message = $_.Exception.Message
    Write-Host "Przywracanie nie powiodło się: $Message"
    $DatabaseUsable = $false
    if ($DatabasePath -and (Test-Path -LiteralPath $DatabasePath -PathType Leaf)) { $DatabaseUsable = Test-DatabaseSnapshot }
    if ($DatabaseUsable -and !$TaskStartAttempted) {
        try {
            $TaskStartAttempted = $true
            Invoke-Control 'start'
            $TaskStopped = $false
            Wait-Health
            Remove-Item -LiteralPath $MaintenancePath -Force -ErrorAction SilentlyContinue
        } catch { $Message += ' Nie udało się ponownie uruchomić serwera: ' + $_.Exception.Message }
    }
    try { Write-RestoreStatus $false $Message } catch { Write-Host "Nie zapisano statusu przywracania: $($_.Exception.Message)" }
    exit 1
} finally {
    if ($Lock) { $Lock.Dispose() }
    if ($OperationsLock -and (Test-Path -LiteralPath $OperationsLock -PathType Leaf)) {
        try {
            $CurrentLock = Get-Content -LiteralPath $OperationsLock -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($CurrentLock.token -eq $LockToken) { Remove-Item -LiteralPath $OperationsLock -Force }
        } catch { if ($LockCreated) { Remove-Item -LiteralPath $OperationsLock -Force -ErrorAction SilentlyContinue } }
    }
    if ($TranscriptStarted) { Stop-Transcript | Out-Null }
}
