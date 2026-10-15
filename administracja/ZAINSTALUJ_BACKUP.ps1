# Uruchom raz jako administrator po skopiowaniu administracja poza program_dir.
param([string]$At='22:00',[string]$TaskName='Marand-Technologia-Backup')
$ErrorActionPreference='Stop'
$Config=Join-Path $PSScriptRoot 'konfiguracja.json'
if (!(Test-Path -LiteralPath $Config -PathType Leaf)) { throw 'Skopiuj konfiguracja.przyklad.json jako konfiguracja.json i uzupełnij ścieżki.' }
$Cfg=Get-Content -Raw -Encoding UTF8 $Config | ConvertFrom-Json
$Script=Join-Path $PSScriptRoot 'backup_scheduled.ps1'
if (!(Get-Command node.exe -ErrorAction SilentlyContinue)) { throw 'Nie znaleziono Node.js 24.15 lub nowszego.' }
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { throw 'Zadanie już istnieje. Sprawdź je zamiast tworzyć drugi harmonogram.' }
& $Script -ConfigPath $Config
if ($LASTEXITCODE -ne 0) { throw 'Pierwsza kopia nie powiodła się. Nie zainstalowano harmonogramu.' }
$Credential=Get-Credential -Message 'Konto kopii: odczyt danych i programu, zapis katalogu kopii oraz statusu'
if (!$Credential) { throw 'Nie wskazano konta.' }
$PowerShell=(Get-Process -Id $PID).Path
$Arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -ConfigPath "{1}"' -f $Script,$Config
$Action=New-ScheduledTaskAction -Execute $PowerShell -Argument $Arguments -WorkingDirectory $PSScriptRoot
$Trigger=New-ScheduledTaskTrigger -Daily -At $At
$Settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 15) -ExecutionTimeLimit (New-TimeSpan -Hours 2)
$Password=$Credential.GetNetworkCredential().Password
try {
    Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -User $Credential.UserName -Password $Password -Description 'Marand: zweryfikowana dzienna kopia SQLite' | Out-Null
} finally { $Password=$null; $Credential=$null }
Start-ScheduledTask -TaskName $TaskName
Write-Host 'Harmonogram uruchomiony testowo. Sprawdź LastTaskResult=0 oraz backup_status.json.'
Get-ScheduledTaskInfo -TaskName $TaskName
