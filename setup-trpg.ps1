# Sets up D:\TRPG with Claude Code Game Studios, OmniRoute, Graphify and Ponytail.
# Run in PowerShell:
#   irm https://raw.githubusercontent.com/gangjip0924/1/claude/gracious-fermat-0k29gm/setup-trpg.ps1 | iex

$ErrorActionPreference = "Stop"
$Target = "D:\TRPG"
$Raw = "https://raw.githubusercontent.com/gangjip0924/1/claude/gracious-fermat-0k29gm"

# Use throw rather than exit: under "irm | iex" exit would close the window.
function Need($cmd, $hint) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        throw "[missing] $cmd - install with: $hint"
    }
}

# Native commands don't throw on failure, so check the exit code ourselves.
# No declared params, so flags like -e can't bind to the function by prefix.
function Run {
    $exe, $rest = $args
    & $exe @rest
    if ($LASTEXITCODE -ne 0) { throw "'$args' failed (exit $LASTEXITCODE)" }
}

Need git    "winget install Git.Git   (also provides bash)"
Need node   "Node 22 from https://nodejs.org  (OmniRoute doesn't support 24+)"
Need python "winget install Python.Python.3.12"
Need claude "irm https://claude.ai/install.ps1 | iex"
# Git for Windows doesn't put bash on PATH; Claude Code finds it here itself.
if (-not (Test-Path "$env:ProgramFiles\Git\bin\bash.exe")) {
    throw "[missing] Git Bash - install with: winget install Git.Git   (Game Studios hooks need bash)"
}

# 1. Claude Code Game Studios -> D:\TRPG
if ((Test-Path $Target) -and (Get-ChildItem $Target -Force | Select-Object -First 1)) {
    throw "$Target already exists and is not empty. Delete it and run again."
}
Run git clone https://github.com/Donchitos/Claude-Code-Game-Studios.git $Target
Set-Location $Target

# Draft TRPG game brief; /brainstorm refines it instead of starting over.
Invoke-WebRequest "$Raw/trpg/design/game-brief.md" -OutFile "design\game-brief.md" -UseBasicParsing

# 2. OmniRoute (AI gateway, http://localhost:20128)
# npm.cmd, not npm: the default execution policy blocks npm.ps1.
Run npm.cmd install -g omniroute

# 3. Graphify (PyPI package name is graphifyy, with two y's)
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Run winget install --id astral-sh.uv --exact --accept-source-agreements --accept-package-agreements
}
$env:Path = [Environment]::GetEnvironmentVariable("Path", "User") + ";" +
            [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
            "$env:USERPROFILE\.local\bin;" + $env:Path
Run uv tool install graphifyy
Run uv tool update-shell
Run graphify claude install --project

# 4. Ponytail (Claude Code plugin)
& claude plugin marketplace add DietrichGebert/ponytail
if ($LASTEXITCODE -eq 0) { & claude plugin install ponytail@ponytail }
if ($LASTEXITCODE -ne 0) {
    Write-Host "Ponytail: run these inside Claude Code instead:" -ForegroundColor Yellow
    Write-Host "  /plugin marketplace add DietrichGebert/ponytail"
    Write-Host "  /plugin install ponytail@ponytail"
}

Write-Host ""
Write-Host "Done. Next:" -ForegroundColor Green
Write-Host "  cd $Target"
Write-Host "  claude        (then type /start)"
