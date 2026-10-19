param([ValidateSet('backup','update','update-latest')][string]$Operation='backup')

$ErrorActionPreference = 'Stop'
trap {
    Write-Host "Aktualizator nie powiódł się: $($_.Exception.Message)" -ForegroundColor Red
    if ($Operation -eq 'update-latest') { Read-Host 'Naciśnij Enter, aby zamknąć' | Out-Null }
    exit 1
}

function Test-IsAdministrator {
    $Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $Principal = New-Object Security.Principal.WindowsPrincipal($Identity)
    return $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if ($Operation -eq 'update-latest' -and !(Test-IsAdministrator)) {
    $EscapedScriptPath = $PSCommandPath.Replace("'", "''")
    $ElevatedCommand = "try { & '$EscapedScriptPath' -Operation update-latest; exit 0 } catch { Write-Error `$_; Read-Host 'Naciśnij Enter, aby zamknąć' | Out-Null; exit 1 }"
    $EncodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($ElevatedCommand))
    $ElevatedProcess = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand',$EncodedCommand) -Wait -PassThru
    exit $ElevatedProcess.ExitCode
}

$Config = Join-Path $PSScriptRoot 'konfiguracja.json'
if (!(Test-Path -LiteralPath $Config -PathType Leaf)) { throw 'Brak konfiguracja.json. Najpierw uruchom INSTALL_SERVER.cmd z paczki wydania.' }
$Cfg = Get-Content -LiteralPath $Config -Raw -Encoding UTF8 | ConvertFrom-Json

function Get-NodePath {
    if ($Cfg.node_path -and (Test-Path -LiteralPath ([string]$Cfg.node_path) -PathType Leaf)) { return [string]$Cfg.node_path }
    $Command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($Command) { return $Command.Source }
    throw 'Nie znaleziono Node.js. Uruchom ponownie INSTALL_SERVER.cmd albo zainstaluj Node.js 24.15 lub nowszy.'
}

function Invoke-UpdatePackage([string]$Package, [string]$Version, [string]$Digest) {
    if (!(Test-Path -LiteralPath $Package -PathType Leaf)) { throw 'Nie znaleziono pliku aktualizacji.' }
    $Node = Get-NodePath
    $env:MARAND_UPDATE_CONFIG = $Config
    try {
        & $Node (Join-Path $PSScriptRoot 'updater.js') update --package $Package --version $Version --sha256 $Digest
        if ($LASTEXITCODE -ne 0) { throw "Aktualizacja zakończona błędem $LASTEXITCODE." }
    } finally { Remove-Item Env:\MARAND_UPDATE_CONFIG -ErrorAction SilentlyContinue }
}

if ($Operation -eq 'update' -or $Operation -eq 'update-latest') {
    $CfgDataDir = [IO.Path]::GetFullPath([string]$Cfg.data_dir)
    $CfgProgramDir = [IO.Path]::GetFullPath([string]$Cfg.program_dir)
    $CurrentReleasePath = Join-Path $CfgProgramDir 'release.json'
    if (!(Test-Path -LiteralPath $CurrentReleasePath -PathType Leaf)) { throw 'Brak zainstalowanej aplikacji. Najpierw uruchom INSTALL_SERVER.cmd z paczki wydania.' }
    $CurrentRelease = Get-Content -LiteralPath $CurrentReleasePath -Raw -Encoding UTF8 | ConvertFrom-Json

    if ($Operation -eq 'update-latest') {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $Repo = 'zvxnz7/MarandTechnology'
        $Headers = @{
            Accept = 'application/vnd.github+json'
            'X-GitHub-Api-Version' = '2022-11-28'
            'User-Agent' = 'MarandTechnology-Standalone-Updater'
        }
        Write-Host 'Sprawdzam najnowsze wydanie na GitHubie...' -ForegroundColor Cyan
        $Release = Invoke-RestMethod -Method Get -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers $Headers -TimeoutSec 30
        if ([string]$Release.tag_name -notmatch '^v?(\d+\.\d+\.\d+)$') { throw 'GitHub zwrócił wydanie z nieobsługiwanym numerem wersji.' }
        $LatestVersion = $Matches[1]
        try {
            $LatestVersionObject = [version]$LatestVersion
            $CurrentVersionObject = [version][string]$CurrentRelease.version
        } catch { throw 'Nie można odczytać wersji zainstalowanej aplikacji lub najnowszego wydania.' }
        if ($LatestVersionObject -le $CurrentVersionObject) {
            Write-Host "Masz już najnowszą wersję ($($CurrentRelease.version))." -ForegroundColor Green
            Read-Host 'Naciśnij Enter, aby zamknąć' | Out-Null
            return
        }

        $Assets = @($Release.assets | Where-Object { $_.name -eq 'marand-node-release.zip' })
        if ($Assets.Count -ne 1) { throw 'Najnowsze wydanie GitHub nie zawiera jednej paczki marand-node-release.zip.' }
        $Asset = $Assets[0]
        if ([string]$Asset.browser_download_url -notmatch '^https://github\.com/zvxnz7/MarandTechnology/releases/download/') {
            throw 'Adres paczki w wydaniu GitHub jest nieprawidłowy.'
        }
        if ([string]$Asset.digest -notmatch '^sha256:([a-fA-F0-9]{64})$') { throw 'GitHub nie udostępnił sumy SHA-256 paczki. Aktualizacja została przerwana.' }
        $ExpectedDigest = $Matches[1].ToLowerInvariant()
        $UpdatesDir = Join-Path $CfgDataDir 'updates'
        New-Item -ItemType Directory -Force -Path $UpdatesDir | Out-Null
        $PackagePath = Join-Path $UpdatesDir "marand-node-$LatestVersion-$($ExpectedDigest.Substring(0,12)).zip"
        try {
            Write-Host "Pobieram wersję $LatestVersion z GitHuba..." -ForegroundColor Cyan
            Invoke-WebRequest -Method Get -Uri $Asset.browser_download_url -OutFile $PackagePath -Headers @{ 'User-Agent' = 'MarandTechnology-Standalone-Updater'; Accept = 'application/octet-stream' } -UseBasicParsing -TimeoutSec 300
            if (!(Test-Path -LiteralPath $PackagePath -PathType Leaf)) { throw 'GitHub nie pobrał pliku paczki.' }
            $ActualDigest = (Get-FileHash -Algorithm SHA256 -LiteralPath $PackagePath).Hash.ToLowerInvariant()
            if ($ActualDigest -ne $ExpectedDigest) { throw 'Pobrana paczka nie zgadza się z sumą SHA-256 z GitHuba.' }
            Invoke-UpdatePackage -Package $PackagePath -Version $LatestVersion -Digest $ExpectedDigest
            Write-Host "Zainstalowano wersję $LatestVersion. Baza danych i pliki użytkowników zostały zachowane." -ForegroundColor Green
        } finally {
            Remove-Item -LiteralPath $PackagePath -Force -ErrorAction SilentlyContinue
        }
        Read-Host 'Naciśnij Enter, aby zamknąć' | Out-Null
    } else {
        $Package = Read-Host 'Wklej pełną ścieżkę do ZIP-a wydania GitHub'
        $Package = $Package.Trim().Trim('"').Trim("'")
        if (!(Test-Path -LiteralPath $Package -PathType Leaf)) { throw 'Nie znaleziono paczki ZIP.' }
        $Temp = Join-Path $env:TEMP ('marand-manifest-' + [guid]::NewGuid().ToString('N'))
        try {
            Expand-Archive -LiteralPath $Package -DestinationPath $Temp
            $ManifestPath = Join-Path $Temp 'release.json'
            if (!(Test-Path -LiteralPath $ManifestPath -PathType Leaf)) { throw 'Paczka nie zawiera release.json.' }
            $Manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
            $Digest = (Get-FileHash -Algorithm SHA256 -LiteralPath $Package).Hash.ToLowerInvariant()
            Invoke-UpdatePackage -Package $Package -Version ([string]$Manifest.version) -Digest $Digest
        } finally {
            if (Test-Path -LiteralPath $Temp) { Remove-Item -LiteralPath $Temp -Recurse -Force }
        }
    }
} else {
    & (Join-Path $PSScriptRoot 'backup_scheduled.ps1') -ConfigPath $Config
    if ($LASTEXITCODE -ne 0) { throw "Kopia zakończona błędem $LASTEXITCODE." }
}
