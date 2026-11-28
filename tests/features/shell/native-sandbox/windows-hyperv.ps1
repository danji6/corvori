# Probe native Windows container support on a disposable runner.
$ErrorActionPreference = 'Stop'
$architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture
$docker = Get-Command docker.exe -ErrorAction SilentlyContinue
$wsb = Get-Command wsb.exe -ErrorAction SilentlyContinue
Write-Host "Architecture=$architecture Docker=$([bool]$docker) WindowsSandboxCLI=$([bool]$wsb)"

function Report-Unavailable([string]$Reason) {
    Write-Host "::notice::Hyper-V workspace test unavailable. $Reason"
    Add-Content $env:GITHUB_STEP_SUMMARY "Hyper-V workspace test on ${architecture}: unavailable. $Reason"
    exit 0
}

if ($architecture -ne 'X64') {
    Report-Unavailable 'The pinned Microsoft Nano Server image is amd64 only.'
}
if (!$docker) { Report-Unavailable 'Docker CLI is missing.' }
$engine = & $docker.Source info --format '{{.OSType}}'
if ($LASTEXITCODE -ne 0 -or $engine -ne 'windows') {
    Report-Unavailable 'A Windows container engine is required.'
}

$image = 'mcr.microsoft.com/windows/nanoserver@sha256:2c6fc384de19a486358dc1d78d95ad3b25adaf4393ea96654437e18615391fe8'
$root = Join-Path $env:RUNNER_TEMP ('corvori-hyperv-' + [guid]::NewGuid())
$shared = New-Item -Type Directory -Path (Join-Path $root 'view') -Force
try {
    $outside = Join-Path $root 'outside.txt'
    Set-Content -LiteralPath $outside 'outside-fixture'
    Set-Content -LiteralPath (Join-Path $shared.FullName 'input.txt') 'workspace-fixture'
    # The container sees a disposable projected directory. The real repository is never mounted.
    $mount = "type=bind,source=$($shared.FullName),target=C:\work"
    @(
        '@echo off'
        "if exist `"$outside`" exit /b 21"
        'type C:\work\input.txt || exit /b 22'
        'cmd.exe /d /c copy /y C:\work\input.txt C:\work\written.txt'
        'exit /b %ERRORLEVEL%'
    ) | Set-Content -LiteralPath (Join-Path $shared.FullName 'verify.cmd') -Encoding ascii
    & $docker.Source run --rm --isolation=hyperv --network none --mount $mount $image cmd.exe /d /c C:\work\verify.cmd
    if ($LASTEXITCODE -ne 0) {
        throw "Hyper-V workspace command returned $LASTEXITCODE. See the engine error above."
    }
    if ((Get-Content (Join-Path $shared.FullName 'written.txt') -Raw).Trim() -ne 'workspace-fixture') {
        throw 'The sandboxed write was not visible in the shared directory.'
    }
    Add-Content $env:GITHUB_STEP_SUMMARY 'Hyper-V workspace fixture passed on x64 with networking disabled.'
} finally {
    Remove-Item -LiteralPath $root -Recurse -Force
}
