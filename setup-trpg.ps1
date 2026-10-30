# Sets up D:\TRPG with Claude Code Game Studios, OmniRoute, Graphify and Ponytail.
# Run in PowerShell:  powershell -ExecutionPolicy Bypass -File .\setup-trpg.ps1

$ErrorActionPreference = "Stop"
$Target = "D:\TRPG"

function Need($cmd, $hint) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        Write-Host "[missing] $cmd - $hint" -ForegroundColor Red
        exit 1
    }
}

Need git    "winget install Git.Git"
Need node   "winget install OpenJS.NodeJS.LTS  (Node 22 LTS recommended)"
Need python "winget install Python.Python.3.12"
Need claude "irm https://claude.ai/install.ps1 | iex"

# 1. Claude Code Game Studios -> D:\TRPG
if ((Test-Path $Target) -and (Get-ChildItem $Target -Force | Select-Object -First 1)) {
    Write-Host "$Target already exists and is not empty. Aborting." -ForegroundColor Red
    exit 1
}
git clone https://github.com/Donchitos/Claude-Code-Game-Studios.git $Target
Set-Location $Target

# 2. OmniRoute (AI gateway, http://localhost:20128)
npm install -g omniroute

# 3. Graphify (PyPI package name is graphifyy, with two y's)
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    winget install --id astral-sh.uv -e
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "User") + ";" + $env:Path
}
uv tool install graphifyy
uv tool update-shell
graphify claude install --project

# 4. Ponytail (Claude Code plugin)
try {
    claude plugin marketplace add DietrichGebert/ponytail
    claude plugin install ponytail@ponytail
} catch {
    Write-Host "Ponytail: run these inside Claude Code instead:" -ForegroundColor Yellow
    Write-Host "  /plugin marketplace add DietrichGebert/ponytail"
    Write-Host "  /plugin install ponytail@ponytail"
}

Write-Host ""
Write-Host "Done. Next:" -ForegroundColor Green
Write-Host "  cd $Target"
Write-Host "  claude        (then type /start)"
