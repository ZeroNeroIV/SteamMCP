# Usage: .\deploy\tunnel.ps1 [-Port 8080]
# Starts steam-mcp on 127.0.0.1:<Port> and exposes it over HTTPS with a free Cloudflare Quick Tunnel.
param([int]$Port = 8080)
$ErrorActionPreference = "Stop"

$rootDir = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $rootDir ".env"

# Ensure bun and cloudflared are findable in this shell
foreach ($p in @("$env:USERPROFILE\.bun\bin", "${env:ProgramFiles(x86)}\cloudflared", "$env:ProgramFiles\cloudflared")) {
  if ((Test-Path $p) -and ($env:Path -notlike "*$p*")) { $env:Path += ";$p" }
}
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) { throw "bun not found on PATH" }
if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
  throw "cloudflared not found. Install with: winget install -e --id Cloudflare.cloudflared"
}

# Read MCP_AUTH_TOKEN from .env / env, or generate and save one into .env
$token = $env:MCP_AUTH_TOKEN
if (-not $token -and (Test-Path $envFile)) {
  foreach ($raw in Get-Content $envFile) {
    if ($raw -match '^\s*MCP_AUTH_TOKEN\s*=\s*(.+)$') {
      $token = $Matches[1].Trim().Trim('"').Trim("'")
    }
  }
}
if (-not $token) {
  $bytes = New-Object byte[] 24; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $token = [Convert]::ToBase64String($bytes) -replace '[+/=]', ''
  Add-Content -Path $envFile -Value "`nMCP_AUTH_TOKEN=$token"
  Write-Host "Generated MCP_AUTH_TOKEN and saved it to .env"
}

$env:MCP_AUTH_TOKEN = $token
$env:HOST = "127.0.0.1"
$env:PORT = "$Port"

Write-Host "Starting steam-mcp HTTP server on http://127.0.0.1:$Port/mcp ..."
$server = Start-Process -FilePath "bun" -ArgumentList @("src/cli.ts", "http") -WorkingDirectory $rootDir -PassThru -NoNewWindow

try {
  # Wait briefly for /healthz
  for ($i = 0; $i -lt 30; $i++) {
    try {
      $h = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 1
      if ($h.StatusCode -eq 200) { break }
    } catch { Start-Sleep -Milliseconds 200 }
  }

  Write-Host ""
  Write-Host "============================================================"
  Write-Host " Owner passphrase (MCP_AUTH_TOKEN): $token"
  Write-Host " Paste the *.trycloudflare.com URL below + '/mcp' into Gemini"
  Write-Host "============================================================"
  Write-Host ""

  cloudflared tunnel --url "http://127.0.0.1:$Port"
} finally {
  if ($server -and -not $server.HasExited) {
    Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
  }
}
