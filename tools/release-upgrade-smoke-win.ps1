$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
$oldDir = if ($env:OLD_RELEASE_DIR) { $env:OLD_RELEASE_DIR } else { Join-Path $repo "old-release" }
$newDir = if ($env:NEW_RELEASE_DIR) { $env:NEW_RELEASE_DIR } else { Join-Path $repo "release" }
$oldInstaller = Get-ChildItem $oldDir -Filter *.exe -ErrorAction SilentlyContinue | Select-Object -First 1
$newInstaller = Get-ChildItem $newDir -Filter *.exe | Select-Object -First 1
if (-not $newInstaller) { throw "未找到当前版本 EXE" }
if (-not $oldInstaller) {
  if ($env:ALLOW_MISSING_UPGRADE_BASELINE -eq "1") { Write-Host "无上一版 Windows 资产，跳过升级 smoke"; exit 0 }
  throw "缺少上一版 Windows EXE；如为首个跨平台版本，请显式允许缺失基线"
}

$root = Join-Path $env:RUNNER_TEMP ("agenthub-upgrade-" + [guid]::NewGuid().ToString("N"))
$installDir = Join-Path $root "app"
$dataDir = Join-Path $root "data"
$skillsDir = Join-Path $root "skills"
New-Item -ItemType Directory -Force -Path $root | Out-Null

function Install-App([string]$installer) {
  $r = Start-Process -FilePath $installer -ArgumentList @("/S", "/D=$installDir") -Wait -PassThru
  if ($r.ExitCode -ne 0) { throw "安装失败：$installer exit=$($r.ExitCode)" }
  $app = Get-ChildItem -Path $installDir -Recurse -Filter AgentHub.exe | Select-Object -First 1
  if (-not $app) { throw "安装后未找到 AgentHub.exe" }
  return $app
}
function App-Version([string]$file) { return (Get-Item $file).VersionInfo.ProductVersion }
function Launch-App([string]$file) {
  $env:AGENTHUB_ALLOW_MULTI = "1"
  $env:AGENTHUB_DATA_DIR = $dataDir
  $env:AGENT_SKILLS_HOME = $skillsDir
  $env:ELECTRON_DISABLE_GPU = "1"
  $log = Join-Path $root ("app-" + [guid]::NewGuid().ToString("N") + ".log")
  $p = Start-Process -FilePath $file -PassThru -RedirectStandardOutput $log -RedirectStandardError ($log + ".err")
  Start-Sleep -Seconds 8
  if ($p.HasExited) { Get-Content $log, ($log + ".err") -ErrorAction SilentlyContinue; throw "应用启动后提前退出" }
  & taskkill /PID $p.Id /T /F | Out-Null
}

$appOld = Install-App $oldInstaller.FullName
$vOld = App-Version $appOld.FullName
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
Set-Content -Path (Join-Path $dataDir "upgrade-smoke.txt") -Value $vOld -Encoding UTF8
Launch-App $appOld.FullName

$appNew = Install-App $newInstaller.FullName
$vNew = App-Version $appNew.FullName
if ($env:AGENTHUB_ALLOW_SAME_VERSION -ne "1") {
  $oldVer = [version]$vOld
  $newVer = [version]$vNew
  if ($newVer -le $oldVer) { throw "升级版本未递增：$vOld -> $vNew" }
}
if ((Get-Content (Join-Path $dataDir "upgrade-smoke.txt") -Raw).Trim() -ne $vOld) { throw "升级后用户数据丢失" }
Launch-App $appNew.FullName

$appRollback = Install-App $oldInstaller.FullName
if ((App-Version $appRollback.FullName) -ne $vOld) { throw "回滚版本异常" }
if ((Get-Content (Join-Path $dataDir "upgrade-smoke.txt") -Raw).Trim() -ne $vOld) { throw "回滚后用户数据丢失" }
Launch-App $appRollback.FullName

$uninstaller = Get-ChildItem -Path $installDir -Recurse -File | Where-Object { $_.Name -match '^Uninstall.*\.exe$' } | Select-Object -First 1
if ($uninstaller) { Start-Process -FilePath $uninstaller.FullName -ArgumentList "/S" -Wait | Out-Null }
Write-Host "Windows 升级/回滚 smoke 通过：$vOld -> $vNew -> $vOld"
