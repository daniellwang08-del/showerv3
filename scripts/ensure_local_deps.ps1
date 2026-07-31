# Ensure Redis (Docker) + Postgres are reachable before start.cmd launches workers.
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

function Test-Port([int]$Port) {
    try {
        $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
        return $null -ne $c
    } catch {
        return $false
    }
}

Write-Host '[deps] Starting Redis via Docker Compose...'
docker compose up -d redis
if ($LASTEXITCODE -ne 0) {
    Write-Host 'ERROR: docker compose failed for redis. Is Docker Desktop running?'
    exit 1
}

# Prefer native Postgres (avoids fighting Docker for :5432 on Windows).
$pgServices = @(Get-Service -Name 'postgresql*' -ErrorAction SilentlyContinue)
if ($pgServices.Count -gt 0) {
    foreach ($svc in $pgServices) {
        if ($svc.Status -ne 'Running') {
            Write-Host "[deps] Starting Windows service $($svc.Name)..."
            Start-Service -Name $svc.Name
        } else {
            Write-Host "[deps] Windows Postgres already running: $($svc.Name)"
        }
    }
}

# If nothing listens on 5432, fall back to Docker Postgres (profile docker-db).
$deadline = (Get-Date).AddSeconds(25)
while (-not (Test-Port 5432) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 1
}

if (-not (Test-Port 5432)) {
    Write-Host '[deps] No Postgres on :5432 — starting Docker Postgres (profile docker-db)...'
    # Stop conflicting listeners if any half-bound state
    docker compose --profile docker-db up -d postgres
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'ERROR: could not start Docker Postgres on :5432'
        exit 1
    }
    $deadline = (Get-Date).AddSeconds(45)
    do {
        $health = docker inspect --format '{{.State.Health.Status}}' showerv3-postgres 2>$null
        if ($health -eq 'healthy') { break }
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)
}

if (-not (Test-Port 5432)) {
    Write-Host 'ERROR: PostgreSQL is not listening on localhost:5432'
    Write-Host '       Start your Postgres service, or: docker compose --profile docker-db up -d postgres'
    exit 1
}

if (-not (Test-Port 6379)) {
    Write-Host 'ERROR: Redis is not listening on localhost:6379'
    exit 1
}

Write-Host '[deps] Redis :6379 and Postgres :5432 are up.'
exit 0
