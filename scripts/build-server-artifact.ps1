# Build the standalone server deployment artifact on the Windows dev machine.
# Produces out\kla-server-<version>-<stamp>.tar.gz containing dist/, migrations/,
# package.json and a fully materialized production node_modules (hoisted, no
# junctions/symlinks), ready to extract under /home/kla/releases/<version> on
# the Linux host.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\build-server-artifact.ps1
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# Disable pnpm's verify-deps-before-run auto-install: this script drives the
# install/deploy steps explicitly, and the check can strip devDependencies
# (e.g. reinstall with --production) in a non-TTY shell.
$env:npm_config_verify_deps_before_run = 'false'
$env:npm_config_confirm_modules_purge = 'false'

$stage = Join-Path $env:TEMP "kla-build\$([Guid]::NewGuid().ToString('N'))"
$out = Join-Path $stage 'out'
New-Item -ItemType Directory -Path $out -Force | Out-Null

try {
    Write-Host '==> build contracts'
    & pnpm --filter '@kla-workstation/contracts' build
    if ($LASTEXITCODE -ne 0) { throw 'contracts build failed' }

    Write-Host '==> build server'
    & pnpm --filter '@kla-workstation/server' build
    if ($LASTEXITCODE -ne 0) { throw 'server build failed' }

    # pnpm >= 10 requires --legacy (or inject-workspace-packages) to bundle
    # workspace:* dependencies into the deployed package.
    # node-linker=hoisted produces a flat, npm-style node_modules with no
    # symlinks/junctions. The default isolated linker's junctions cannot simply
    # be materialized by copying (fastify would lose access to its transitive
    # deps like avvio, which live as siblings under .pnpm), so hoisted is
    # mandatory.
    Write-Host '==> pnpm deploy --prod --legacy (hoisted)'
    & pnpm --filter '@kla-workstation/server' deploy --prod --legacy --config.node-linker=hoisted $out
    if ($LASTEXITCODE -ne 0) { throw 'pnpm deploy failed' }

    # deploy follows npm packing rules, so the gitignored dist/ tree is excluded
    # (and migrations/ may be dropped as well); copy both in explicitly.
    Write-Host '==> copy dist & migrations'
    Copy-Item -Path (Join-Path $root 'server\dist') -Destination (Join-Path $out 'dist') -Recurse -Force
    Copy-Item -Path (Join-Path $root 'server\migrations') -Destination (Join-Path $out 'migrations') -Recurse -Force

    # The server only needs dist/, migrations/, package.json and node_modules/ at
    # runtime; drop sources and configs that deploy copied from the package dir.
    Write-Host '==> trim non-runtime files'
    foreach ($drop in @('src', 'docs', 'scripts', 'tsconfig.json', 'tsconfig.scripts.json', 'vitest.config.ts', '.env.example', 'README.md')) {
        Remove-Item -LiteralPath (Join-Path $out $drop) -Recurse -Force -ErrorAction SilentlyContinue
    }

    Write-Host '==> verify artifact'
    $required = @(
        'dist\server.js',
        'dist\migrations',
        'migrations',
        'package.json',
        'node_modules\@kla-workstation\contracts\package.json',
        'node_modules\fastify\package.json',
        'node_modules\avvio\package.json'
    )
    foreach ($rel in $required) {
        if (-not (Test-Path (Join-Path $out $rel))) { throw "missing required path: $rel" }
    }
    & node --check (Join-Path $out 'dist\server.js')
    if ($LASTEXITCODE -ne 0) { throw 'dist/server.js failed syntax check' }
    # hoisted layout must contain zero reparse points; any leftover junction/
    # symlink would break on the Linux host.
    $left = @(Get-ChildItem -Path $out -Recurse -Force -Attributes ReparsePoint)
    if ($left.Count -gt 0) {
        $left | ForEach-Object { Write-Host "    leftover: $($_.FullName)" }
        throw "artifact still contains $($left.Count) reparse points"
    }

    $pkg = Get-Content (Join-Path $out 'package.json') -Raw | ConvertFrom-Json
    $stamp = Get-Date -Format 'yyyyMMdd-HHmm'
    $artifactName = "kla-server-$($pkg.version)-$stamp.tar.gz"
    $artifactDir = Join-Path $root 'out'
    New-Item -ItemType Directory -Path $artifactDir -Force | Out-Null
    $artifact = Join-Path $artifactDir $artifactName

    Write-Host "==> pack $artifactName"
    tar -czf $artifact -C $out .
    if ($LASTEXITCODE -ne 0) { throw 'tar failed' }

    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $artifact).Hash.ToLower()
    $sizeMb = [math]::Round((Get-Item -LiteralPath $artifact).Length / 1MB, 1)
    Write-Host ''
    Write-Host "artifact : $artifact"
    Write-Host "size     : $sizeMb MB"
    Write-Host "sha256   : $hash"
    Write-Host ''
    Write-Host 'next steps (see docs/DEPLOY_CENTOS7_BARE_METAL.md):'
    Write-Host "  scp `"$artifact`" root@<host>:/tmp/"
    Write-Host '  on host: verify sha256, extract to /home/kla/releases/<version>, switch /home/kla/current, systemctl restart kla'
}
finally {
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    # pnpm deploy --prod strips the main workspace to production-only (drops
    # eslint/typescript etc.); reinstall full deps so local dev keeps working.
    Write-Host '==> restore workspace dev dependencies'
    & pnpm install
}
