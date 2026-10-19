$ErrorActionPreference = 'Stop'
$Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$Principal = New-Object Security.Principal.WindowsPrincipal($Identity)
if (!$Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $Arguments = '-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $PSCommandPath
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $Arguments
    exit
}

$Token = Read-Host 'Paste a fine-grained GitHub token with Contents: Read-only access to zvxnz7/MarandTechnology' -AsSecureString
$Credential = New-Object -TypeName System.Net.NetworkCredential -ArgumentList @('', $Token)
$PlainToken = $Credential.Password
if ([string]::IsNullOrWhiteSpace($PlainToken)) { throw 'No token entered; existing token was not changed.' }

Add-Type -AssemblyName System.Security
$Bytes = [Text.Encoding]::UTF8.GetBytes($PlainToken)
$Protected = [Security.Cryptography.ProtectedData]::Protect(
    $Bytes, $null, [Security.Cryptography.DataProtectionScope]::LocalMachine
)
[IO.File]::WriteAllBytes((Join-Path $PSScriptRoot 'github-token.dpapi'), $Protected)
[Array]::Clear($Bytes, 0, $Bytes.Length)
$PlainToken = $null
$Credential = $null
Write-Host 'Encrypted GitHub token saved outside the app folder. Restart the MarandTechnologia task to apply it.'
