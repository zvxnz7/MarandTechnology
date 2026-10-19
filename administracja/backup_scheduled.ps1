param([string]$ConfigPath=(Join-Path $PSScriptRoot 'konfiguracja.json'))
$ErrorActionPreference='Stop'
$Cfg=Get-Content -Raw -Encoding UTF8 $ConfigPath | ConvertFrom-Json
$Step='odczyt konfiguracji kopii'
$Node=if ($Cfg.node_path -and (Test-Path -LiteralPath $Cfg.node_path -PathType Leaf)) { [IO.Path]::GetFullPath($Cfg.node_path) } else { (Get-Command node.exe -ErrorAction Stop).Source }
$Data=[IO.Path]::GetFullPath($Cfg.data_dir)
$Program=[IO.Path]::GetFullPath($Cfg.program_dir)
$Root=[IO.Path]::GetFullPath($Cfg.backup_dir)
$Daily=Join-Path $Root 'dzienne'
$Weekly=Join-Path $Root 'tygodniowe'
$Temp=Join-Path $Root ('tymczasowe\'+[guid]::NewGuid().ToString('N'))
$StatusPath=Join-Path $Data 'backup_status.json'
$env:MARAND_DATA=$Data
$env:MARAND_DATABASE=Join-Path $Data 'marand.sqlite3'
function Prune-Copies($Directory,$Pattern,$Keep) {
    $Files=@(Get-ChildItem -LiteralPath $Directory -File | Where-Object { $_.Name -match $Pattern } | Sort-Object Name -Descending)
    foreach ($Old in $Files | Select-Object -Skip $Keep) { Remove-Item -LiteralPath $Old.FullName -Force }
}
$Previous=$null
if(Test-Path -LiteralPath $StatusPath) { try { $Previous=Get-Content -Raw $StatusPath | ConvertFrom-Json } catch {} }
try {
    $Step='tworzenie katalogów kopii'
    New-Item -ItemType Directory -Force -Path $Daily,$Weekly,$Temp | Out-Null
    $Database=Join-Path $Temp 'marand.sqlite3'
    $Step='kopiowanie bazy i powiązanych zdjęć'
    & $Node (Join-Path $Program 'manage.js') backup --output $Database
    if ($LASTEXITCODE -ne 0) { throw "Polecenie kopii zakonczylo sie bledem $LASTEXITCODE." }
    # manage.js exports the photo files referenced by this exact DB snapshot.
    if(Test-Path -LiteralPath ($Database+'.photos')) { Move-Item -LiteralPath ($Database+'.photos') -Destination (Join-Path $Temp 'photos') }
    Copy-Item -LiteralPath (Join-Path $Data 'secret.key') -Destination $Temp
    $Sources=Join-Path $Program 'seed\sources'
    if(Test-Path -LiteralPath $Sources) { Copy-Item -LiteralPath $Sources -Destination (Join-Path $Temp 'sources') -Recurse }
    $Manifest=@()
    foreach($File in Get-ChildItem -LiteralPath $Temp -Recurse -File) {
        $Manifest+=@{file=$File.FullName.Substring($Temp.Length+1);sha256=(Get-FileHash -LiteralPath $File.FullName -Algorithm SHA256).Hash}
    }
    $Manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $Temp 'manifest.json') -Encoding UTF8
    $Zip=$Temp+'.zip'
    $Step='pakowanie kopii do archiwum ZIP'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($Temp,$Zip,[IO.Compression.CompressionLevel]::Optimal,$false)
    # ZIP is only published after successful compression; preserve the old copy on failure.
    $Step='zapisywanie dziennej kopii'
    $DailyBackup=Join-Path $Daily ('D-'+(Get-Date -Format 'yyyy-MM-dd')+'.zip')
    if(Test-Path -LiteralPath $DailyBackup) { [IO.File]::Replace($Zip,$DailyBackup,$null) } else { Move-Item -LiteralPath $Zip -Destination $DailyBackup }
    $Today=(Get-Date).Date
    $Monday=$Today.AddDays(-(([int]$Today.DayOfWeek+6)%7))
    $WeeklyBackup=Join-Path $Weekly ('W-'+$Monday.ToString('yyyy-MM-dd')+'.zip')
    if(!(Test-Path -LiteralPath $WeeklyBackup)) {
        Copy-Item -LiteralPath $DailyBackup -Destination ($WeeklyBackup+'.tmp')
        Move-Item -LiteralPath ($WeeklyBackup+'.tmp') -Destination $WeeklyBackup
    }
    $Keep=[int]$Cfg.daily_keep; if($Keep -lt 1 -or $Keep -gt 1000) { $Keep=14 }
    $Weeks=[int]$Cfg.weekly_keep; if($Weeks -lt 1 -or $Weeks -gt 520) { $Weeks=12 }
    $Step='usuwanie najstarszych kopii zgodnie z limitem'
    Prune-Copies $Daily '^D-\d{4}-\d{2}-\d{2}\.zip$' $Keep
    Prune-Copies $Weekly '^W-\d{4}-\d{2}-\d{2}\.zip$' $Weeks
    $Result=[ordered]@{ok=$true;last_success=(Get-Date).ToUniversalTime().ToString('o');daily=$DailyBackup;weekly=$WeeklyBackup;daily_keep=$Keep;weekly_keep=$Weeks}
} catch {
    Write-Host "Niepowodzenie etapu: $Step (backup_scheduled.ps1, wiersz $($_.InvocationInfo.ScriptLineNumber)): $($_.Exception.Message)" -ForegroundColor Red
    $Result=@{ok=$false;last_success=$Previous.last_success;last_failure=(Get-Date).ToUniversalTime().ToString('o');error=$_.Exception.Message}
    throw
} finally {
    if($Result) {
        [IO.File]::WriteAllText($StatusPath+'.tmp',($Result|ConvertTo-Json -Depth 4),[Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath ($StatusPath+'.tmp') -Destination $StatusPath -Force
    }
    if(Test-Path -LiteralPath $Temp) { Remove-Item -LiteralPath $Temp -Recurse -Force }
    if(Test-Path -LiteralPath ($Temp+'.zip')) { Remove-Item -LiteralPath ($Temp+'.zip') -Force }
}
