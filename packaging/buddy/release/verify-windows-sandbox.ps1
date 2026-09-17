param(
  [Parameter(Mandatory)][string]$SandboxExecutable,
  [Parameter(Mandatory)][string]$AdversaryExecutable,
  [string]$InstallerExecutable,
  [switch]$InstallComponent
)

$ErrorActionPreference = 'Stop'
$sandbox = (Resolve-Path -LiteralPath $SandboxExecutable).Path
$adversary = (Resolve-Path -LiteralPath $AdversaryExecutable).Path
$fixture = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../../apps/buddy/native/host/__tests__/shell_sandbox.windows.mjs')).Path
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if ($identity.IsSystem -or -not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this acceptance supervisor from an elevated user session, not LocalSystem; commands run as a temporary standard user.'
}
if ($InstallComponent) {
  & $sandbox install
  if ($LASTEXITCODE -ne 0) { throw "Sandbox component installation failed: $LASTEXITCODE" }
}
$id = [Guid]::NewGuid().ToString('N')
$directory = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) ('lexora-sandbox-acceptance-' + $id)
New-Item -ItemType Directory -Path $directory | Out-Null
$log = Join-Path $directory 'result.log'
$userName = 'LxSandbox' + $id.Substring(0, 10)
$user = $null
$payload = $null
$child = $null
try {
  $password = ConvertTo-SecureString ('Lx9!' + [Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N')) -AsPlainText -Force
  $user = New-LocalUser -Name $userName -Password $password -AccountNeverExpires -UserMayNotChangePassword
  Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $user
  $acl = Get-Acl -LiteralPath $directory
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($user.SID, 'Modify', 'ContainerInherit, ObjectInherit', 'None', 'Allow'))
  Set-Acl -LiteralPath $directory -AclObject $acl
  $payload = New-Item -ItemType Directory -Path (Join-Path $directory 'payload')
  Copy-Item -LiteralPath (Get-Command node.exe -ErrorAction Stop).Source -Destination (Join-Path $payload 'node.exe')
  Copy-Item -LiteralPath $adversary -Destination (Join-Path $payload 'sandbox-adversary.exe')
  Copy-Item -LiteralPath $fixture -Destination (Join-Path $payload 'shell_sandbox.windows.mjs')
  $desktopAcceptance = ''
  if ($InstallerExecutable) {
    Copy-Item -LiteralPath (Resolve-Path -LiteralPath $InstallerExecutable).Path -Destination (Join-Path $payload 'desktop-installer.exe')
    $desktopVerifier = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../ci/verify-windows-install.mjs')).Path.Replace("'", "''")
    $desktopAcceptance = @"
  `$installer = Start-Process -FilePath (Join-Path `$PWD 'payload\desktop-installer.exe') -ArgumentList '/S' -Wait -PassThru
  if (`$installer.ExitCode -ne 0) { throw "Standard user NSIS installation failed: `$(`$installer.ExitCode)" }
  `$installed = Join-Path `$env:LOCALAPPDATA 'Programs\Lexora Buddy'
  & (Join-Path `$PWD 'payload\node.exe') '$desktopVerifier' `$installed --require-sandbox >> 'result.log' 2>&1
  if (`$LASTEXITCODE -ne 0) { throw "Installed standard user Desktop verification failed: `$LASTEXITCODE" }
"@
  }
  $script = @"
`$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath '$($directory.Replace("'", "''"))'
try {
  `$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  `$principal = [Security.Principal.WindowsPrincipal]::new(`$identity)
  `$administrator = `$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  "Acceptance identity: `$(`$identity.Name); administrator: `$administrator" | Set-Content -LiteralPath 'result.log' -Encoding UTF8
  if (`$identity.User.Value -ne '$($user.SID.Value)' -or `$administrator) {
    throw 'Windows sandbox acceptance requires the temporary standard user, not an administrator token.'
  }
  `$profileKey = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\' + `$identity.User.Value
  `$env:USERPROFILE = [Environment]::ExpandEnvironmentVariables((Get-ItemPropertyValue -LiteralPath `$profileKey -Name ProfileImagePath))
  `$env:APPDATA = Join-Path `$env:USERPROFILE 'AppData\Roaming'
  `$env:LOCALAPPDATA = Join-Path `$env:USERPROFILE 'AppData\Local'
  `$env:TEMP = Join-Path `$env:LOCALAPPDATA 'Temp'
  `$env:TMP = `$env:TEMP
  `$env:BUDDY_SANDBOX_TEST_ADVERSARY = Join-Path `$PWD 'payload\sandbox-adversary.exe'
  & `$env:ComSpec /d /c '"payload\node.exe" --test --test-reporter=tap "payload\shell_sandbox.windows.mjs" >> "result.log" 2>&1'
  if (`$LASTEXITCODE -ne 0) { throw "Sandbox acceptance failed: `$LASTEXITCODE" }
$desktopAcceptance
  exit 0
}
catch {
  `$_ | Out-String | Add-Content -LiteralPath 'result.log' -Encoding UTF8
  exit 1
}
"@
  $scriptPath = Join-Path $payload 'run.ps1'
  Set-Content -LiteralPath $scriptPath -Value $script -Encoding UTF8
  $credential = [PSCredential]::new("$env:COMPUTERNAME\$userName", $password)
  $child = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -ArgumentList "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$scriptPath`"" -WorkingDirectory $directory -Credential $credential -LoadUserProfile -WindowStyle Hidden -PassThru
  if (-not $child.WaitForExit($(if ($InstallerExecutable) { 540000 } else { 360000 }))) { throw 'Windows sandbox acceptance timed out.' }
  if ($child.ExitCode -ne 0) { throw "Windows sandbox acceptance failed: $($child.ExitCode). Report: $log" }
  if (-not (Test-Path -LiteralPath $log)) { throw 'Windows sandbox acceptance did not produce a report.' }
}
finally {
  if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log -Encoding UTF8 }
  if ($child) {
    if (-not $child.HasExited) { $child.Kill($true); $child.WaitForExit() }
    $child.Dispose()
  }
  if ($user) {
    try {
      Get-Process -IncludeUserName | Where-Object UserName -EQ "$env:COMPUTERNAME\$userName" | Stop-Process -Force
      $cleanupDeadline = [DateTime]::UtcNow.AddSeconds(30)
      do {
        $profile = Get-CimInstance Win32_UserProfile -Filter "SID='$($user.SID.Value)'"
        if (-not $profile.Loaded) { break }
        if ([DateTime]::UtcNow -ge $cleanupDeadline) { throw "Temporary acceptance profile is still loaded: $($profile.LocalPath)" }
        Start-Sleep -Milliseconds 250
      } while ($true)
      if ($profile) { $profile | Remove-CimInstance }
    }
    finally { Remove-LocalUser -SID $user.SID }
  }
  if ($payload) { Remove-Item -LiteralPath $payload.FullName -Recurse -Force }
}
