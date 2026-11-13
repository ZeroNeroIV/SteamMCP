# Usage: .\deploy\cloudrun.ps1 [-Project <gcp-project-id>] [-Region us-central1] [-SteamId <id>]
# Reads defaults from .env at the project root: GCP_PROJECT_ID, GCP_REGION, STEAM_ID, STEAM_API_KEY
param(
  [string]$Project = "",
  [string]$Region = "",
  [string]$Service = "steam-mcp",
  [string]$SteamId = ""
)
$ErrorActionPreference = "Stop"

# Load .env from project root if present
$rootDir = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $rootDir ".env"
$dotEnv = @{}
if (Test-Path $envFile) {
  foreach ($raw in Get-Content $envFile) {
    $line = $raw.Trim()
    if (-not $line -or $line.StartsWith("#")) { continue }
    $eq = $line.IndexOf("=")
    if ($eq -le 0) { continue }
    $k = $line.Substring(0, $eq).Trim()
    $v = $line.Substring($eq + 1).Trim()
    if (($v.StartsWith('"') -and $v.EndsWith('"')) -or ($v.StartsWith("'") -and $v.EndsWith("'"))) {
      $v = $v.Substring(1, $v.Length - 2)
    } else {
      $v = ($v -replace '\s+#.*$', '').Trim()
    }
    if ($k) { $dotEnv[$k] = $v }
  }
}

if (-not $Project) { $Project = if ($dotEnv["GCP_PROJECT_ID"]) { $dotEnv["GCP_PROJECT_ID"] } else { $env:GCP_PROJECT_ID } }
if (-not $Region)  { $Region  = if ($dotEnv["GCP_REGION"])     { $dotEnv["GCP_REGION"] }     elseif ($env:GCP_REGION) { $env:GCP_REGION } else { "us-central1" } }
if (-not $SteamId) { $SteamId = if ($dotEnv["STEAM_ID"])       { $dotEnv["STEAM_ID"] }       else { $env:STEAM_ID } }
$steamApiKey = if ($dotEnv["STEAM_API_KEY"]) { $dotEnv["STEAM_API_KEY"] } else { $env:STEAM_API_KEY }

if (-not $Project) {
  throw "Missing GCP project ID. Pass -Project <id> or set GCP_PROJECT_ID in .env"
}

gcloud services enable run.googleapis.com secretmanager.googleapis.com cloudbuild.googleapis.com --project $Project

function Ensure-Secret($name, $prompt, $generate, $presetValue) {
  $exists = gcloud secrets describe $name --project $Project 2>$null
  if (-not $exists) {
    if ($generate) {
      $bytes = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
      $value = [Convert]::ToBase64String($bytes) -replace '[+/=]', ''
      Write-Host "Generated $name (store it for your MCP clients): $value"
    } elseif ($presetValue) {
      $value = $presetValue
      Write-Host "Using $name from .env / environment"
    } else {
      $value = Read-Host $prompt -AsSecureString | ForEach-Object { [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($_)) }
    }
    $tmp = New-TemporaryFile
    Set-Content -NoNewline -Path $tmp -Value $value
    gcloud secrets create $name --data-file=$tmp --project $Project
    Remove-Item $tmp
  }
}
Ensure-Secret "steam-api-key" "Steam Web API key" $false $steamApiKey
Ensure-Secret "steam-mcp-auth-token" "" $true ""

$envVars = "NODE_ENV=production"
if ($SteamId) { $envVars += ",STEAM_ID=$SteamId" }

Push-Location $rootDir
try {
  gcloud run deploy $Service --source . --project $Project --region $Region `
    --allow-unauthenticated `
    --set-env-vars $envVars `
    --set-secrets "STEAM_API_KEY=steam-api-key:latest,MCP_AUTH_TOKEN=steam-mcp-auth-token:latest" `
    --max-instances 3
} finally {
  Pop-Location
}

Write-Host "`nMCP endpoint: $(gcloud run services describe $Service --project $Project --region $Region --format 'value(status.url)')/mcp"
