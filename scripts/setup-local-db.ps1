# Bootstrap local PostgreSQL for dev: creates betting_app user + cockfight_betting DB,
# applies Prisma migrations, and seeds the admin user.
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/setup-local-db.ps1
#   # or with an explicit postgres superuser password:
#   $env:POSTGRES_PASSWORD = 'your-postgres-password'
#   powershell -ExecutionPolicy Bypass -File scripts/setup-local-db.ps1

$ErrorActionPreference = 'Stop'

$pgBin = 'C:\Program Files\PostgreSQL\18\bin'
$pgData = 'C:\Program Files\PostgreSQL\18\data'
$pgHba = Join-Path $pgData 'pg_hba.conf'
$psql = Join-Path $pgBin 'psql.exe'
$pgCtl = Join-Path $pgBin 'pg_ctl.exe'
$repoRoot = Split-Path $PSScriptRoot -Parent

$appUser = 'betting_app'
$appPassword = 'betting_app_dev_pw'
$dbName = 'cockfight_betting'

function Invoke-Psql {
  param([string]$Sql)
  $env:PGPASSWORD = $env:POSTGRES_PASSWORD
  & $psql -U postgres -h localhost -d postgres -v ON_ERROR_STOP=1 -c $Sql
  if ($LASTEXITCODE -ne 0) { throw "psql failed: $Sql" }
}

function Invoke-PsqlScalar {
  param([string]$Sql)
  $env:PGPASSWORD = $env:POSTGRES_PASSWORD
  $result = & $psql -U postgres -h localhost -d postgres -tAc $Sql
  if ($LASTEXITCODE -ne 0) { throw "psql failed: $Sql" }
  return ("$result").Trim()
}

Write-Host "Ensuring PostgreSQL role and database exist..."

$hbaBackup = $null
$usedTrustBootstrap = $false

if (-not $env:POSTGRES_PASSWORD) {
  if (-not (Test-Path $pgHba)) {
    throw "PostgreSQL pg_hba.conf not found at $pgHba"
  }

  Write-Host "No POSTGRES_PASSWORD set; temporarily enabling local trust auth for bootstrap."
  $hbaBackup = Get-Content $pgHba -Raw
  $hbaTrusted = $hbaBackup -replace 'scram-sha-256', 'trust'
  Set-Content -Path $pgHba -Value $hbaTrusted -NoNewline
  & $pgCtl reload -D $pgData
  if ($LASTEXITCODE -ne 0) { throw 'pg_ctl reload failed' }
  $usedTrustBootstrap = $true
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}

$roleExists = Invoke-PsqlScalar -Sql "SELECT 1 FROM pg_roles WHERE rolname='$appUser'"
if ($roleExists -ne '1') {
  Invoke-Psql -Sql "CREATE USER $appUser WITH PASSWORD '$appPassword';"
} else {
  Invoke-Psql -Sql "ALTER USER $appUser WITH PASSWORD '$appPassword';"
}

$dbExists = Invoke-PsqlScalar -Sql "SELECT 1 FROM pg_database WHERE datname='$dbName'"
if ($dbExists -ne '1') {
  Invoke-Psql -Sql "CREATE DATABASE $dbName OWNER $appUser;"
}

Invoke-Psql -Sql "GRANT ALL PRIVILEGES ON DATABASE $dbName TO $appUser;"

if ($usedTrustBootstrap) {
  Set-Content -Path $pgHba -Value $hbaBackup -NoNewline
  & $pgCtl reload -D $pgData
  if ($LASTEXITCODE -ne 0) { throw 'pg_ctl reload failed while restoring pg_hba.conf' }
  Write-Host "Restored pg_hba.conf."
}

Write-Host "Applying Prisma migrations..."
$env:Path = "C:\Program Files\nodejs;$env:Path"
Push-Location $repoRoot
try {
  npm run db:migrate
  if ($LASTEXITCODE -ne 0) { throw 'npm run db:migrate failed' }

  Write-Host "Seeding database..."
  npm run seed
  if ($LASTEXITCODE -ne 0) { throw 'npm run seed failed' }
} finally {
  Pop-Location
}

Write-Host "Local database setup complete."
