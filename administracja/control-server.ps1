param(
    [Parameter(Mandatory=$true)][ValidateSet('start','stop','status')][string]$Action,
    [string]$ConfigPath=(Join-Path $PSScriptRoot 'konfiguracja.json')
)

$ErrorActionPreference = 'Stop'
$Cfg = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($Cfg.service_type -ne 'scheduled-task') { throw 'Ta kontrolka jest przeznaczona dla instalacji jako Scheduled Task.' }
$TaskName = [string]$Cfg.service_name
if ([string]::IsNullOrWhiteSpace($TaskName)) { throw 'Brak service_name w konfiguracja.json.' }
$Task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
$AdminDir = Split-Path -Parent $ConfigPath
$StopFile = Join-Path $AdminDir 'stop.request'
$PidFile = Join-Path $AdminDir 'server.pid'
$SettingsPath = Join-Path $AdminDir 'server-settings.json'
$Settings = if (Test-Path -LiteralPath $SettingsPath) { Get-Content -LiteralPath $SettingsPath -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }

function Wait-TaskStopped {
    $Deadline = (Get-Date).AddSeconds(60)
    do {
        $Current = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        if ($Current.State -ne 'Running') { return }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $Deadline)
    throw "Task $TaskName did not stop within 60 seconds."
}

function Wait-TaskStarted {
    $Deadline = (Get-Date).AddSeconds(60)
    do {
        $Current = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        if ($Current.State -eq 'Running') { return }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $Deadline)
    throw "Task $TaskName did not start within 60 seconds."
}

switch ($Action) {
    'status' {
        Get-ScheduledTaskInfo -TaskName $TaskName
        break
    }
    'stop' {
        [IO.File]::WriteAllText($StopFile, 'stop', [Text.UTF8Encoding]::new($false))
        $StoppedNode = $false
        if (Test-Path -LiteralPath $PidFile) {
            $RawPid = (Get-Content -LiteralPath $PidFile -Raw).Trim()
            $NodePid = 0
            if ([int]::TryParse($RawPid, [ref]$NodePid) -and $NodePid -gt 0) {
                $NodeDetails = Get-CimInstance Win32_Process -Filter "ProcessId = $NodePid" -ErrorAction SilentlyContinue
                $ExpectedScript = if ($Settings) { Join-Path ([IO.Path]::GetFullPath([string]$Settings.program_dir)) 'manage.js' } else { '' }
                $ExpectedNode = if ($Settings) { [IO.Path]::GetFullPath([string]$Settings.node_path) } else { '' }
                $IsExpected = $NodeDetails -and $NodeDetails.ExecutablePath -and $NodeDetails.CommandLine -and
                    ([IO.Path]::GetFullPath($NodeDetails.ExecutablePath) -ieq $ExpectedNode) -and
                    ($NodeDetails.CommandLine.IndexOf($ExpectedScript, [StringComparison]::OrdinalIgnoreCase) -ge 0)
                if ($IsExpected) {
                    Stop-Process -Id $NodePid -Force -ErrorAction Stop
                    $Deadline = (Get-Date).AddSeconds(60)
                    while ((Get-Process -Id $NodePid -ErrorAction SilentlyContinue) -and (Get-Date) -lt $Deadline) { Start-Sleep -Milliseconds 250 }
                    if (Get-Process -Id $NodePid -ErrorAction SilentlyContinue) { throw "Node.js pid $NodePid did not stop." }
                    $StoppedNode = $true
                } elseif ($NodeDetails) {
                    throw "The PID file points to another process. Process $NodePid was not stopped."
                }
            }
        }
        $Task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        if ($Task.State -eq 'Running' -and -not $StoppedNode) {
            Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        }
        Wait-TaskStopped
        break
    }
    'start' {
        if (Test-Path -LiteralPath $StopFile) { Remove-Item -LiteralPath $StopFile -Force }
        $Task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        if ($Task.State -ne 'Running') { Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop }
        Wait-TaskStarted
        break
    }
}
