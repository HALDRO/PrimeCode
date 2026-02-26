# PrimeCode - Release Script
# Автоматизирует: проверка → bump версии → коммит → тег → пуш → GitHub Actions делает остальное
#
# Использование:
#   .\scripts\release.ps1 patch    # 0.2.0 → 0.2.1
#   .\scripts\release.ps1 minor    # 0.2.0 → 0.3.0
#   .\scripts\release.ps1 major    # 0.2.0 → 1.0.0
#   .\scripts\release.ps1 0.5.0    # конкретная версия

param(
    [Parameter(Position = 0)]
    [string]$Version
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot

Push-Location $ProjectRoot
try {
    # --- Читаем текущую версию сразу, чтобы показать в меню ---
    $pkgJson = Get-Content "package.json" -Raw | ConvertFrom-Json
    $currentVersion = $pkgJson.version
    $parts = $currentVersion.Split(".")
    $major = [int]$parts[0]
    $minor = [int]$parts[1]
    $patch = [int]$parts[2]

    $patchVersion = "$major.$minor.$($patch + 1)"
    $minorVersion = "$major.$($minor + 1).0"
    $majorVersion = "$($major + 1).0.0"

    # --- Интерактивное меню, если версия не передана ---
    if (-not $Version) {
        Write-Host ""
        Write-Host "  PrimeCode Release" -ForegroundColor Cyan
        Write-Host "  Current version: $currentVersion" -ForegroundColor DarkGray
        Write-Host ""
        Write-Host "  Choose release type:" -ForegroundColor White
        Write-Host ""
        Write-Host "  [1] patch  $currentVersion -> $patchVersion   (bug fixes, small changes)" -ForegroundColor Yellow
        Write-Host "  [2] minor  $currentVersion -> $minorVersion   (new features, improvements)" -ForegroundColor Yellow
        Write-Host "  [3] major  $currentVersion -> $majorVersion     (breaking changes, big release)" -ForegroundColor Yellow
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
                    Write-Host "ERROR: Invalid version format. Use X.Y.Z (e.g. 0.5.0)" -ForegroundColor Red
                    exit 1
                }
            }
            default {
                Write-Host "ERROR: Invalid choice. Run the script again." -ForegroundColor Red
                exit 1
            }
        }
        Write-Host ""
    }

    # --- 1. Проверяем чистоту рабочего дерева ---
    Write-Host "[1/7] Checking git status..." -ForegroundColor Cyan
    $gitStatus = git status --porcelain
    if ($gitStatus) {
        Write-Host "ERROR: Working tree is dirty. Commit or stash changes first." -ForegroundColor Red
        Write-Host $gitStatus
        exit 1
    }

    $branch = git rev-parse --abbrev-ref HEAD
    Write-Host "  Branch: $branch" -ForegroundColor DarkGray
    Write-Host "  Current version: $currentVersion" -ForegroundColor DarkGray

    # --- 2. Вычисляем новую версию ---
    Write-Host "`n[2/7] Calculating new version..." -ForegroundColor Cyan

    switch ($Version) {
        "patch" { $newVersion = $patchVersion }
        "minor" { $newVersion = $minorVersion }
        "major" { $newVersion = $majorVersion }
        default {
            if ($Version -match '^\d+\.\d+\.\d+$') {
                $newVersion = $Version
            } else {
                Write-Host "ERROR: Invalid version '$Version'. Use patch/minor/major or X.Y.Z" -ForegroundColor Red
                exit 1
            }
        }
    }

    Write-Host "  New version: $currentVersion -> $newVersion" -ForegroundColor Green

    # --- 4. Проверяем что тег не существует ---
    $tagExists = git tag -l "v$newVersion"
    if ($tagExists) {
        Write-Host "ERROR: Tag v$newVersion already exists!" -ForegroundColor Red
        exit 1
    }

    # --- 5. Lint + Tests ---
    Write-Host "`n[3/7] Running lint..." -ForegroundColor Cyan
    npm run lint:biome
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: Lint failed! Fix errors before releasing." -ForegroundColor Red
        exit 1
    }

    npm run lint:tsc
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: TypeScript check failed!" -ForegroundColor Red
        exit 1
    }

    Write-Host "`n[4/7] Running tests..." -ForegroundColor Cyan
    npm test
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: Tests failed! Fix them before releasing." -ForegroundColor Red
        exit 1
    }

    # --- 6. Bump версии в package.json ---
    Write-Host "`n[5/7] Bumping version in package.json..." -ForegroundColor Cyan
    $content = Get-Content "package.json" -Raw
    $content = $content -replace "`"version`": `"$currentVersion`"", "`"version`": `"$newVersion`""
    Set-Content "package.json" -Value $content -NoNewline

    # --- 7. Коммит + тег ---
    Write-Host "`n[6/7] Creating commit and tag..." -ForegroundColor Cyan
    git add package.json
    git commit -m "release: v$newVersion"
    git tag "v$newVersion"

    # --- 8. Пуш ---
    Write-Host "`n[7/7] Pushing to remote..." -ForegroundColor Cyan
    git push origin $branch
    git push origin "v$newVersion"

    Write-Host "`n========================================" -ForegroundColor Green
    Write-Host "  Release v$newVersion pushed!" -ForegroundColor Green
    Write-Host "  GitHub Actions will build and publish." -ForegroundColor Green
    Write-Host "  Check: https://github.com/HALDRO/PrimeCode/actions" -ForegroundColor DarkGray
    Write-Host "========================================`n" -ForegroundColor Green

} finally {
    Pop-Location
}
