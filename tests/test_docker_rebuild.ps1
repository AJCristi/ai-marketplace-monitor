# No Docker daemon, live monitor, credentials, or additional test modules needed.
$ErrorActionPreference = 'Stop'
$rebuild = Join-Path (Split-Path $PSScriptRoot -Parent) 'docker\rebuild.ps1'

function global:git { $global:LASTEXITCODE = 0; 'test-revision' }
function global:Start-Sleep {}
function global:docker {
    $command = $args[0]
    $global:calls.Add(($args -join ' '))
    $global:LASTEXITCODE = 0
    if ($command -eq $global:failure) { $global:LASTEXITCODE = 1; return }
    switch ($command) {
        'ps' { if ($global:existing) { 'old-id' } }
        'inspect' { if ($global:running) { 'true' } else { 'false' } }
        'create' { 'new-id' }
        'exec' {
            $global:probes++
            if ($global:probes -eq 1) { $global:LASTEXITCODE = 1 }
        }
    }
}

function Assert-That($condition, $message) {
    if (-not $condition) { throw $message }
}

foreach ($scenario in @('running', 'stopped', 'absent', 'build', 'create', 'exec', 'exec-stopped')) {
    $global:calls = New-Object 'System.Collections.Generic.List[string]'
    $global:existing = $scenario -ne 'absent'
    $global:running = $scenario -notin @('stopped', 'exec-stopped')
    $global:failure = if ($scenario -eq 'exec-stopped') { 'exec' }
        elseif ($scenario -in @('build', 'create', 'exec')) { $scenario } else { '' }
    $global:probes = 0
    $caught = $false
    try { & $rebuild -ConfigDirectory $env:TEMP | Out-Null }
    catch { $caught = $true }
    $history = $global:calls -join "`n"
    Assert-That ($caught -eq ($global:failure -ne '')) "$scenario returned the wrong outcome"
    Assert-That ($history -notmatch '(?m)^rm .*--volumes') 'Persistent volumes must not be deleted'

    if ($scenario -eq 'build') {
        Assert-That ($history -notmatch '(?m)^(stop|rename|create|rm) ') 'Build failure modified containers'
    }
    elseif ($scenario -in @('create', 'exec', 'exec-stopped')) {
        Assert-That ($history -match '(?m)^rename old-id aimm$') 'Old container name was not restored'
        Assert-That (($history -match '(?m)^start old-id$') -eq $global:running) 'Old running/stopped state was not restored'
        Assert-That ($history -notmatch '(?m)^rm old-id$') 'Rollback removed the old container'
        if ($global:failure -eq 'exec') {
            Assert-That ($history -match '(?m)^rm --force new-id$') 'Unhealthy replacement was not removed'
        }
    }
    else {
        Assert-That ($history -match '(?m)^start new-id$') 'Replacement was not started'
        Assert-That ($global:probes -eq 2) 'Readiness was not retried'
        Assert-That ($history -match '--publish 127.0.0.1:8467:8467') 'Dashboard must stay local-only'
        Assert-That ($history -match '--restart unless-stopped') 'Restart policy was lost'
        if ($global:existing) {
            Assert-That ($history -match '(?m)^rm old-id$') 'Old container was not cleaned up'
        }
        if ($scenario -eq 'stopped') {
            Assert-That ($history -notmatch '(?m)^stop ') 'Stopped container was stopped again'
        }
    }
    Write-Host "PASS: $scenario"
}
