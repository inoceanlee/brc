param(
  [Parameter(Mandatory = $true)][string]$CliEntry,
  [Parameter(Mandatory = $true)][string]$RelayEntry,
  [Parameter(Mandatory = $true)][string]$WorkspaceRoot,
  [Parameter(Mandatory = $true)][string]$TraefikBinary,
  [string]$DataRoot = (Join-Path $env:TEMP 'brc-reboot-recovery-verify'),
  [int]$RelayPort = 23000,
  [int]$ProxyPort = 23001,
  [int]$HealthPort = 23002,
  [string]$AdminPassword = 'RebootRecoveryOnly-2026'
)

$ErrorActionPreference = 'Stop'

function Invoke-JsonCommand {
  param([string[]]$Arguments, [int[]]$AllowedExitCodes = @(0))
  $output = & node @Arguments 2>&1 | Out-String
  $exitCode = $LASTEXITCODE
  if ($AllowedExitCodes -notcontains $exitCode) {
    throw "Command exited $exitCode. Arguments: $($Arguments -join ' '). Output: $output"
  }
  $jsonLine = ($output -split "`r?`n" | Where-Object { $_ -match '^\{' } | Select-Object -First 1)
  if (-not $jsonLine) {
    throw "Command produced no JSON. Arguments: $($Arguments -join ' '). Output: $output"
  }
  return @{ Data = ($jsonLine | ConvertFrom-Json); ExitCode = $exitCode; Output = $output }
}

function Get-Services {
  param($Result)
  if ($Result.Data.services) { return $Result.Data.services }
  if ($Result.Data.error.details.command.services) { return $Result.Data.error.details.command.services }
  throw "No service list in output: $($Result.Output)"
}

function Assert-Equal {
  param($Actual, $Expected, [string]$Message)
  if ($Actual -ne $Expected) {
    throw "$Message. Expected '$Expected', got '$Actual'."
  }
}

if (Test-Path $DataRoot) { Remove-Item $DataRoot -Recurse -Force }
New-Item -ItemType Directory -Path $DataRoot -Force | Out-Null

$env:BRC_DATA_ROOT = $DataRoot
$env:BRC_RELAY_PORT = [string]$RelayPort
$env:BRC_TRAEFIK_PORT = [string]$ProxyPort
$env:BRC_TRAEFIK_HEALTH_PORT = [string]$HealthPort
$env:BRC_ADMIN_USER = 'admin'
$env:BRC_ADMIN_PASSWORD = $AdminPassword
$env:BRC_SESSION_SECRET = 'reboot-recovery-verify-session'
$env:DO_NOT_TRACK = '1'
$env:PORT = [string]$RelayPort
$env:HOST = '127.0.0.1'
$env:PUBLIC_URL = "http://127.0.0.1:$ProxyPort"
$env:BRC_DB = Join-Path $DataRoot 'data\relay.sqlite'
$env:BRC_LOG_FILE = Join-Path $DataRoot 'logs\relay.log'
New-Item -ItemType Directory -Path (Split-Path $env:BRC_DB -Parent) -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path $env:BRC_LOG_FILE -Parent) -Force | Out-Null

'' | node $RelayEntry --initialize
Assert-Equal $LASTEXITCODE 0 'relay identity initialization'

$versionRoot = Join-Path $DataRoot 'traefik\versions\3.7.17'
New-Item -ItemType Directory -Path $versionRoot -Force | Out-Null
Copy-Item $TraefikBinary (Join-Path $versionRoot 'traefik.exe') -Force
Set-Content -Path (Join-Path $DataRoot 'traefik\versions.json') -Value '{"version":1,"current":"3.7.17","previous":null}' -Encoding utf8

$setup = Invoke-JsonCommand -Arguments @($CliEntry, 'setup', '--json')
Assert-Equal $setup.Data.command 'setup' 'setup command result'

$foreign = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.CommandLine -and $_.Name -notlike 'node*' -and $_.ProcessId -ne $PID } | Select-Object -First 1
if (-not $foreign) { throw 'No foreign process available for PID reuse simulation.' }

$instanceId = '77777777-8888-9999-aaaa-bbbbbbbbbbbb'
$record = [ordered]@{
  version = 1
  id = $instanceId
  service = 'relay'
  pid = [int]$foreign.ProcessId
  createdAt = '9999999999'
  executablePath = $foreign.ExecutablePath
  commandLine = "$RelayEntry --brc-managed-id=$instanceId"
  workspaceRoot = $WorkspaceRoot
  entrypoint = $RelayEntry
  controlPort = 12345
  controlToken = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
}
$runtime = Join-Path $DataRoot 'runtime'
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
$recordFile = Join-Path $runtime 'relay.json'
Set-Content -Path $recordFile -Value ($record | ConvertTo-Json -Depth 5) -Encoding utf8

$staleStatus = Invoke-JsonCommand -Arguments @($CliEntry, 'status', '--json') -AllowedExitCodes @(0, 1)
$staleServices = Get-Services -Result $staleStatus
$staleRelay = $staleServices | Where-Object { $_.name -eq 'relay' }
Assert-Equal $staleRelay.state 'degraded' 'stale relay status'
Assert-Equal $staleRelay.recoverable $true 'stale relay recovery flag'

$start = Invoke-JsonCommand -Arguments @($CliEntry, 'start', '--json')
Assert-Equal $start.Data.command 'start' 'start command result'

$runningStatus = Invoke-JsonCommand -Arguments @($CliEntry, 'status', '--json')
$runningServices = Get-Services -Result $runningStatus
$relayState = ($runningServices | Where-Object { $_.name -eq 'relay' }).state
$traefikState = ($runningServices | Where-Object { $_.name -eq 'traefik' }).state
$agentState = ($runningServices | Where-Object { $_.name -eq 'agent' }).state
Assert-Equal $relayState 'running' 'relay state after start'
Assert-Equal $traefikState 'running' 'traefik state after start'
Assert-Equal $agentState 'pairing' 'agent state after start'

$stop = Invoke-JsonCommand -Arguments @($CliEntry, 'stop', '--json')
Assert-Equal $stop.Data.command 'stop' 'stop command result'

$finalStatus = Invoke-JsonCommand -Arguments @($CliEntry, 'status', '--json')
$finalServices = Get-Services -Result $finalStatus
Assert-Equal @($finalServices | Where-Object { $_.state -ne 'stopped' }).Count 0 'services still running after stop'

Write-Output 'reboot recovery real usage verification passed'
