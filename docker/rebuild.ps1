param(
    [string]$ConfigDirectory = (Join-Path $env:USERPROFILE '.ai-marketplace-monitor')
)

# Rebuild the local-only Docker setup documented in README.md.
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent

function Invoke-Docker {
    $result = & docker @args
    if ($LASTEXITCODE -ne 0) {
        throw "Docker command failed: $($args[0]) (exit $LASTEXITCODE)"
    }
    $result
}

if (-not (Test-Path -LiteralPath $ConfigDirectory -PathType Container)) {
    throw "Config directory does not exist: $ConfigDirectory"
}
$ConfigDirectory = (Resolve-Path -LiteralPath $ConfigDirectory).Path
$revision = & git -C $repoRoot rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw 'Could not resolve the source revision.' }

$oldId = Invoke-Docker ps -aq --filter 'name=^/aimm$'
$wasRunning = $false
if ($oldId) {
    $wasRunning = (Invoke-Docker inspect --format '{{.State.Running}}' $oldId) -eq 'true'
}

# Docker's build cache still rebuilds the layers affected by checkout changes.
Invoke-Docker build --build-arg "AIMM_BUILD_SHA=$revision" -t aimm:latest $repoRoot

$backupName = 'aimm-backup-' + [guid]::NewGuid().ToString('N')
$renamed = $false
$newId = $null
try {
    if ($oldId) {
        if ($wasRunning) { Invoke-Docker stop --time 30 $oldId }
        Invoke-Docker rename $oldId $backupName
        $renamed = $true
    }
    $newId = Invoke-Docker create --name aimm --restart unless-stopped `
        --publish '127.0.0.1:8467:8467' `
        --mount "type=bind,source=$ConfigDirectory,target=/root/.ai-marketplace-monitor" `
        --env AIMM_WEBUI_LOCAL_ONLY=1 aimm:latest
    Invoke-Docker start $newId

    # Check the web server, not just supervisord's process status.
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        # Windows PowerShell 5.1 can turn native stderr into terminating errors.
        $ErrorActionPreference = 'Continue'
        & docker exec $newId python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8467/api/status', timeout=2).close()" 2>$null | Out-Null
        $probeExit = $LASTEXITCODE
        $ErrorActionPreference = 'Stop'
        if ($probeExit -eq 0) { $ready = $true; break }
        Start-Sleep -Seconds 2
    }
    if (-not $ready) { throw 'The replacement web server did not become ready.' }
}
catch {
    if ($newId) { Invoke-Docker rm --force $newId | Out-Null }
    if ($renamed) { Invoke-Docker rename $oldId aimm }
    if ($oldId -and $wasRunning) { Invoke-Docker start $oldId | Out-Null }
    throw
}

# Remove only the old container; never delete its persistent data or volumes.
if ($oldId) { Invoke-Docker rm $oldId | Out-Null }
Write-Host 'Updated aimm. Open http://localhost:8467'
