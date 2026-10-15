param([string]$ConfigPath=(Join-Path $PSScriptRoot 'konfiguracja.json'))
$ErrorActionPreference='Stop'
$Cfg=Get-Content -Raw -Encoding UTF8 $ConfigPath | ConvertFrom-Json
$Node=if ($Cfg.node_path -and (Test-Path -LiteralPath $Cfg.node_path -PathType Leaf)) { [IO.Path]::GetFullPath($Cfg.node_path) } else { (Get-Command node.exe -ErrorAction Stop).Source }
$Data=[IO.Path]::GetFullPath($Cfg.data_dir)
$Program=[IO.Path]::GetFullPath($Cfg.program_dir)
$BackupRoot=[IO.Path]::GetFullPath($Cfg.backup_dir)
$Daily=Join-Path $BackupRoot 'dzienne'
$TempFolder=Join-Path $BackupRoot 'tymczasowe'
New-Item -ItemType Directory -Force -Path $Daily,$TempFolder | Out-Null
$Stamp=Get-Date -Format 'yyyyMMdd-HHmmss'
$TempBackup=Join-Path $TempFolder ("marand-$Stamp.sqlite3")
$DailyBackup=Join-Path $Daily ("D-"+(Get-Date -Format 'yyyy-MM-dd')+'.sqlite3')
$StatusPath=Join-Path $Data 'backup_status.json'
$env:MARAND_DATA=$Data
try {
    & $Node (Join-Path $Program 'manage.js') backup --output $TempBackup
    if ($LASTEXITCODE -ne 0) { throw "Polecenie kopii zakończyło się błędem $LASTEXITCODE." }
    Move-Item -LiteralPath $TempBackup -Destination $DailyBackup -Force
    $Keep=[int]$Cfg.daily_keep
    if ($Keep -lt 1 -or $Keep -gt 1000) { $Keep=14 }
    $Files=@(Get-ChildItem -LiteralPath $Daily -File | Where-Object { $_.Name -match '^D-\d{4}-\d{2}-\d{2}\.sqlite3$' } | Sort-Object Name -Descending)
    foreach ($Old in $Files | Select-Object -Skip $Keep) { Remove-Item -LiteralPath $Old.FullName -Force }
    $Result=[ordered]@{ok=$true;last_success=(Get-Date).ToUniversalTime().ToString('o');daily=$DailyBackup;daily_keep=$Keep}
    $Json=$Result | ConvertTo-Json -Depth 4
    $TempStatus=$StatusPath+'.tmp'
    [IO.File]::WriteAllText($TempStatus,$Json,[Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $TempStatus -Destination $StatusPath -Force
} catch {
    $Result=@{ok=$false;last_failure=(Get-Date).ToUniversalTime().ToString('o');error=$_.Exception.Message}
    $Json=$Result | ConvertTo-Json -Depth 4
    $TempStatus=$StatusPath+'.tmp'
    [IO.File]::WriteAllText($TempStatus,$Json,[Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $TempStatus -Destination $StatusPath -Force
    throw
} finally {
    if (Test-Path -LiteralPath $TempBackup) { Remove-Item -LiteralPath $TempBackup -Force }
}
