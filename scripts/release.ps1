# PrimeCode - Release Script
# Автоматизирует: проверка → bump версии → коммит → тег → пуш → ожидание CI → откат при провале
#
# Использование:
#   .\scripts\release.ps1 patch    # 1.0.1 → 1.0.2
#   .\scripts\release.ps1 minor    # 1.0.1 → 1.1.0
#   .\scripts\release.ps1 major    # 1.0.1 → 2.0.0
#   .\scripts\release.ps1 0.5.0    # конкретная версия
#   .\scripts\release.ps1          # интерактивное меню

param(
    [Parameter(Position = 0)]
    [string]$Version,
    [switch]$NoWait  # Пропустить ожидание CI
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot

Push-Location $ProjectRoot
try {
    # --- Проверяем наличие gh CLI ---
    if (-not $NoWait) {
        $ghExists = Get-Command gh -ErrorAction SilentlyContinue
        if (-not $ghExists) {
            Write-Host "WARNING: gh CLI not found. Install it to enable CI monitoring." -ForegroundColor Yellow
            Write-Host "  https://cli.github.com/" -ForegroundColor DarkGray
            Write-Host "  Continuing without CI wait...`n" -ForegroundColor DarkGray
            $NoWait = $true
        }
    }

    # --- Читаем текущую версию ---
    $pkgJson = Get-Content "package.json" -Raw | ConvertFrom-Json
    $currentVersion = $pkgJson.version
    $parts = $currentVersion.Split(".")
    $major = [int]$parts[0]
    $minor = [int]$parts[1]
    $patch = [int]$parts[2]

    $patchVersion = "$major.$minor.$($patch + 1)"
    $minorVersion = "$major.$($minor + 1).0"
    $majorVersion = "$($major + 1).0.0"

    # --- Интерактивное меню ---
    if (-not $Version) {
        Write-Host ""
        Write-Host "  PrimeCode Release" -ForegroundColor Cyan
        Write-Host "  Current version: $currentVersion" -ForegroundColor DarkGray
        Write-Host ""
        Write-Host "  Choose release type:" -ForegroundColor White
        Write-Host ""
        Write-Host "  [1] patch  $currentVersion -> $patchVersion   (bug fixes)" -ForegroundColor Yellow
        Write-Host "  [2] minor  $currentVersion -> $minorVersion   (new features)" -ForegroundColor Yellow
        Write-Host "  [3] major  $currentVersion -> $majorVersion     (breaking changes)" -ForegroundColor Yellow
        Write-Host "  [4] custom                       (enter version manually)" -ForegroundColor Yellow
        Write-Host ""

        $choice = Read-Host "  Your choice (1-4)"

        switch ($choice) {
            "1" { $Version = "patch" }
            "2" { $Version = "minor" }
            "3" { $Version = "major" }
            "4" {
                $Version = Read-Host "  Enter version (e.g. 0.5.0)"
                if ($Version -notmatch '^\d+\.\d+\.\d+$') {
                    Write-Host "ERROR: Invalid version format. Use X.Y.Z" -ForegroundColor Red
                    exit 1
                }
            }
            default {
                Write-Host "ERROR: Invalid choice." -ForegroundColor Red
                exit 1
            }
        }
        Write-Host ""
    }

    # --- 1. Git status ---
    Write-Host "[1/8] Checking git status..." -ForegroundColor Cyan
    $gitStatus = git status --porcelain
    if ($gitStatus) {
        Write-Host "ERROR: Working tree is dirty. Commit or stash first." -ForegroundColor Red
        Write-Host $gitStatus
        exit 1
    }

    $branch = git rev-parse --abbrev-ref HEAD
    Write-Host "  Branch: $branch" -ForegroundColor DarkGray

    # --- 2. Вычисляем версию ---
    Write-Host "`n[2/8] Calculating version..." -ForegroundColor Cyan
    switch ($Version) {
        "patch" { $newVersion = $patchVersion }
        "minor" { $newVersion = $minorVersion }
        "major" { $newVersion = $majorVersion }
        default {
            if ($Version -match '^\d+\.\d+\.\d+$') {
                $newVersion = $Version
            } else {
                Write-Host "ERROR: Invalid version '$Version'" -ForegroundColor Red
                exit 1
            }
        }
    }
    Write-Host "  $currentVersion -> $newVersion" -ForegroundColor Green

    $tagExists = git tag -l "v$newVersion"
    if ($tagExists) {
        Write-Host "ERROR: Tag v$newVersion already exists!" -ForegroundColor Red
        exit 1
    }

    # --- 3. Lint ---
    Write-Host "`n[3/8] Running lint..." -ForegroundColor Cyan
    npm run lint:biome
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: Lint failed!" -ForegroundColor Red
        exit 1
    }
    npm run lint:tsc
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: TypeScript check failed!" -ForegroundColor Red
        exit 1
    }

    # --- 4. Tests ---
    Write-Host "`n[4/8] Running tests..." -ForegroundColor Cyan
    npm test
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: Tests failed!" -ForegroundColor Red
        exit 1
    }

    # --- 5. Bump version ---
    Write-Host "`n[5/8] Bumping version..." -ForegroundColor Cyan
    $content = Get-Content "package.json" -Raw
    $content = $content -replace "`"version`": `"$currentVersion`"", "`"version`": `"$newVersion`""
    Set-Content "package.json" -Value $content -NoNewline

    # --- 6. Подтверждение ---
    Write-Host ""
    Write-Host "  Ready to release v$newVersion" -ForegroundColor White
    Write-Host "  Branch: $branch" -ForegroundColor DarkGray
    Write-Host "  This will: commit, tag, push, and trigger CI" -ForegroundColor DarkGray
    Write-Host ""
    $confirm = Read-Host "  Proceed? (y/n)"
    if ($confirm -ne 'y' -and $confirm -ne 'Y') {
        Write-Host "Aborted. Reverting package.json..." -ForegroundColor Yellow
        git checkout package.json
        exit 0
    }

    # --- 7. Commit + tag + push ---
    Write-Host "`n[6/8] Creating commit and tag..." -ForegroundColor Cyan
    git add package.json
    git commit -m "release: v$newVersion"
    git tag "v$newVersion"

    Write-Host "`n[7/8] Pushing..." -ForegroundColor Cyan
    git push origin $branch
    git push origin "v$newVersion"

    # --- 8. Ожидание CI ---
    if ($NoWait) {
        Write-Host "`n========================================" -ForegroundColor Green
        Write-Host "  v$newVersion pushed! CI skipped (--NoWait)" -ForegroundColor Green
        Write-Host "  Check: https://github.com/HALDRO/PrimeCode/actions" -ForegroundColor DarkGray
        Write-Host "========================================`n" -ForegroundColor Green
        exit 0
    }

    Write-Host "`n[8/8] Waiting for CI..." -ForegroundColor Cyan
    Write-Host "  Monitoring GitHub Actions (timeout: 10 min)" -ForegroundColor DarkGray

    $maxWait = 600  # 10 минут
    $elapsed = 0
    $pollInterval = 10
    $runId = $null

    $headSha = git rev-parse HEAD

    # Ждём появления run
    while ($elapsed -lt 60) {
        Start-Sleep -Seconds 5
        $elapsed += 5
        $runLine = gh run list --limit 5 --json databaseId,status,conclusion,headSha 2>$null | ConvertFrom-Json
        if ($runLine) {
            foreach ($r in $runLine) {
                if ($r.headSha -eq $headSha) {
                    $runId = $r.databaseId
                    break
                }
            }
            if ($runId) { break }
        }
    }

    if (-not $runId) {
        Write-Host "  Could not find CI run for commit $headSha. Check manually:" -ForegroundColor Yellow
        Write-Host "  https://github.com/HALDRO/PrimeCode/actions" -ForegroundColor DarkGray
        exit 1
    }

    Write-Host "  Run ID: $runId" -ForegroundColor DarkGray

    # Поллим статус
    while ($elapsed -lt $maxWait) {
        Start-Sleep -Seconds $pollInterval
        $elapsed += $pollInterval

        $run = gh run list --limit 5 --json databaseId,status,conclusion 2>$null | ConvertFrom-Json
        $current = $run | Where-Object { $_.databaseId -eq $runId }

        if (-not $current) { continue }

        $status = $current.status
        $conclusion = $current.conclusion

        if ($status -eq "completed") {
            if ($conclusion -eq "success") {
                Write-Host ""
                Write-Host "  ========================================" -ForegroundColor Green
                Write-Host "    v$newVersion released successfully!" -ForegroundColor Green
                Write-Host "    https://github.com/HALDRO/PrimeCode/releases/tag/v$newVersion" -ForegroundColor DarkGray
                Write-Host "  ========================================" -ForegroundColor Green
                exit 0
            } else {
                Write-Host ""
                Write-Host "  CI FAILED! ($conclusion)" -ForegroundColor Red
                Write-Host "  Rolling back..." -ForegroundColor Yellow

                # Откат: удаляем тег и релиз, ревертим коммит безопасно
                gh release delete "v$newVersion" --yes 2>$null
                git push origin --delete "v$newVersion" 2>$null
                git tag -d "v$newVersion" 2>$null
                git revert HEAD --no-edit
                git push origin $branch

                Write-Host ""
                Write-Host "  Rolled back: tag deleted, release commit reverted." -ForegroundColor Yellow
                Write-Host "  Check logs: gh run view $runId --log-failed" -ForegroundColor DarkGray
                exit 1
            }
        }

        $mins = [math]::Floor($elapsed / 60)
        $secs = $elapsed % 60
        Write-Host "  Waiting... ${mins}m${secs}s ($status)" -ForegroundColor DarkGray
    }

    Write-Host "  Timeout waiting for CI. Check manually:" -ForegroundColor Yellow
    Write-Host "  gh run view $runId" -ForegroundColor DarkGray
    exit 1

} finally {
    Pop-Location
}
