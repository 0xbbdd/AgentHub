$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
$installer = Get-ChildItem (Join-Path $repo "release") -Filter *.exe | Select-Object -First 1
if (-not $installer) { throw "未找到 Windows 安装包" }

$root = Join-Path $env:RUNNER_TEMP ("agenthub-install-smoke-" + [guid]::NewGuid().ToString("N"))
$installDir = Join-Path $root "app"
$dataDir = Join-Path $root "data"
$skillsDir = Join-Path $root "skills"
New-Item -ItemType Directory -Force -Path $root | Out-Null

Write-Host "安装: $($installer.FullName) -> $installDir"
$install = Start-Process -FilePath $installer.FullName -ArgumentList @("/S", "/D=$installDir") -Wait -PassThru
if ($install.ExitCode -ne 0) { throw "安装器退出码 $($install.ExitCode)" }

$app = Get-ChildItem -Path $installDir -Recurse -Filter AgentHub.exe | Select-Object -First 1
if (-not $app) { throw "安装后未找到 AgentHub.exe" }
$appSig = Get-AuthenticodeSignature $app.FullName
if ($appSig.Status -ne "Valid") { throw "安装后的 AgentHub.exe 签名无效：$($appSig.Status)" }

$env:AGENTHUB_ALLOW_MULTI = "1"
$env:AGENTHUB_DATA_DIR = $dataDir
$env:AGENT_SKILLS_HOME = $skillsDir
$env:ELECTRON_DISABLE_GPU = "1"
$log = Join-Path $root "app.log"
$proc = Start-Process -FilePath $app.FullName -PassThru -RedirectStandardOutput $log -RedirectStandardError ($log + ".err")
Start-Sleep -Seconds 10
if ($proc.HasExited) {
  Get-Content $log, ($log + ".err") -ErrorAction SilentlyContinue
  throw "AgentHub 启动后提前退出，exit=$($proc.ExitCode)"
}
Write-Host "启动 OK: pid=$($proc.Id)"
& taskkill /PID $proc.Id /T /F | Out-Null

$uninstaller = Get-ChildItem -Path $installDir -Recurse -File | Where-Object { $_.Name -match '^Uninstall.*\.exe$' } | Select-Object -First 1
if (-not $uninstaller) { throw "未找到卸载程序" }
Write-Host "卸载: $($uninstaller.FullName)"
$uninstall = Start-Process -FilePath $uninstaller.FullName -ArgumentList "/S" -Wait -PassThru
if ($uninstall.ExitCode -ne 0) { throw "卸载器退出码 $($uninstall.ExitCode)" }
Start-Sleep -Seconds 2
$left = Get-ChildItem -Path $installDir -Recurse -Filter AgentHub.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if ($left) { throw "卸载后仍存在 AgentHub.exe" }
Write-Host "Windows 安装/启动/卸载 smoke 通过"
