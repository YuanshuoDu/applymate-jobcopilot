$ErrorActionPreference = 'Stop'

function Read-DotEnvValue {
  param(
    [string[]]$Lines,
    [Parameter(Mandatory = $true)][string]$Name
  )

  $line = $Lines | Where-Object { $_.StartsWith($Name + '=') } | Select-Object -First 1
  if (-not $line) { return $null }

  $value = $line.Substring($Name.Length + 1).Trim()
  if ($value.Length -ge 2 -and (($value[0] -eq [char]34 -and $value[$value.Length - 1] -eq [char]34) -or ($value[0] -eq [char]39 -and $value[$value.Length - 1] -eq [char]39))) {
    $value = $value.Substring(1, $value.Length - 2)
  }

  if ([string]::IsNullOrWhiteSpace($value)) { return $null }
  if ($value.StartsWith('[') -and $value.EndsWith(']')) { return $null }
  return $value
}

$envFile = Join-Path $env:TEMP ("applymate-vercel-production-" + $PID + '.env')
try {
  & pnpm dlx vercel@58.9.0 env pull $envFile --environment=production --yes | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Unable to pull Vercel production environment' }

  $lines = Get-Content -LiteralPath $envFile
  $databaseUrl = Read-DotEnvValue -Lines $lines -Name 'DATABASE_URL'
  if (-not $databaseUrl -and (Test-Path 'apps/web/.env.local')) {
    $localLines = Get-Content -LiteralPath 'apps/web/.env.local'
    $databaseUrl = Read-DotEnvValue -Lines $localLines -Name 'DATABASE_URL'
  }
  if (-not $databaseUrl) { throw 'No production DATABASE_URL is available' }

  # Vercel does not reveal hidden values after creation. Preserve the current
  # Worker values when a hidden value cannot be pulled; only replace them when
  # the host returns a non-empty value.
  $redisUrl = Read-DotEnvValue -Lines $lines -Name 'REDIS_URL'
  $workerSecret = Read-DotEnvValue -Lines $lines -Name 'AGENT_WORKER_SECRET'
  $automationSecret = Read-DotEnvValue -Lines $lines -Name 'AGENT_AUTOMATION_CRON_SECRET'
  $controlSecret = Read-DotEnvValue -Lines $lines -Name 'WORKER_CONTROL_SECRET'
  $maintenanceSecret = Read-DotEnvValue -Lines $lines -Name 'WEB_MAINTENANCE_CRON_SECRET'
  $appUrl = Read-DotEnvValue -Lines $lines -Name 'AUTH_URL'
  if (-not $appUrl) { $appUrl = 'https://applymate.site' }

  $databaseUri = [System.Uri]::new($databaseUrl)
  $databaseHost = $databaseUri.DnsSafeHost
  $appHost = ([Uri]$appUrl).Host
  $redisState = if ($redisUrl) { ([System.Uri]::new($redisUrl)).DnsSafeHost } else { 'preserved-existing' }
  Write-Output "Syncing Worker runtime from Vercel production: db=$databaseHost redis=$redisState web=$appHost"

  $secretArgs = [System.Collections.Generic.List[string]]::new()
  $secretArgs.Add('DATABASE_URL=' + $databaseUrl)
  $secretArgs.Add('AGENT_WEB_URL=' + $appUrl)
  if ($redisUrl) { $secretArgs.Add('REDIS_URL=' + $redisUrl) }
  if ($workerSecret) { $secretArgs.Add('AGENT_WORKER_SECRET=' + $workerSecret) }
  if ($automationSecret) { $secretArgs.Add('AGENT_AUTOMATION_CRON_SECRET=' + $automationSecret) }
  if ($controlSecret) { $secretArgs.Add('WORKER_CONTROL_SECRET=' + $controlSecret) }
  if ($maintenanceSecret) { $secretArgs.Add('WEB_MAINTENANCE_CRON_SECRET=' + $maintenanceSecret) }
  $secretArgs.Add('AGENT_SCHEDULER_ENABLED=1')

  & flyctl secrets set --app applymate-worker @secretArgs | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Fly secret synchronization failed' }

  Write-Output 'Worker runtime secrets synchronized without printing secret values.'
}
finally {
  Remove-Item -LiteralPath $envFile -Force -ErrorAction SilentlyContinue
}
