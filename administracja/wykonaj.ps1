param([ValidateSet('backup','update')][string]$Operation='backup')
$ErrorActionPreference='Stop'
$Config=Join-Path $PSScriptRoot 'konfiguracja.json'
if (!(Test-Path -LiteralPath $Config -PathType Leaf)) { throw 'Skopiuj konfiguracja.przyklad.json jako konfiguracja.json i uzupełnij ścieżki.' }
$Cfg=Get-Content -Raw -Encoding UTF8 $Config | ConvertFrom-Json
$Node=(Get-Command node.exe -ErrorAction Stop).Source

if ($Operation -eq 'update') {
    $Package=Read-Host 'Wklej pełną ścieżkę do ZIP-a wydania GitHub'
    $Package=$Package.Trim('"')
    if (!(Test-Path -LiteralPath $Package -PathType Leaf)) { throw 'Nie znaleziono paczki ZIP.' }
    $Temp=Join-Path $env:TEMP ('marand-manifest-'+[guid]::NewGuid().ToString('N'))
    try {
        Expand-Archive -LiteralPath $Package -DestinationPath $Temp
        $ManifestPath=Join-Path $Temp 'release.json'
        if (!(Test-Path -LiteralPath $ManifestPath -PathType Leaf)) { throw 'Paczka nie zawiera release.json.' }
        $Manifest=Get-Content -Raw -Encoding UTF8 $ManifestPath | ConvertFrom-Json
        $Digest=(Get-FileHash -Algorithm SHA256 -LiteralPath $Package).Hash.ToLowerInvariant()
        $env:MARAND_UPDATE_CONFIG=$Config
        & $Node (Join-Path $PSScriptRoot 'updater.js') update --package $Package --version $Manifest.version --sha256 $Digest
        if ($LASTEXITCODE -ne 0) { throw "Aktualizacja zakończona błędem $LASTEXITCODE." }
    } finally {
        if (Test-Path -LiteralPath $Temp) { Remove-Item -LiteralPath $Temp -Recurse -Force }
    }
} else {
    & (Join-Path $PSScriptRoot 'backup_scheduled.ps1') -ConfigPath $Config
    if ($LASTEXITCODE -ne 0) { throw "Kopia zakończona błędem $LASTEXITCODE." }
}
