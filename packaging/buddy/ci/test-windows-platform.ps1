param(
  [string]$ProjectDirectory = (Join-Path $PSScriptRoot '../../../apps/buddy'),
  [Parameter(Mandatory)][string[]]$TestFiles
)

$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath $ProjectDirectory).Path
$vitest = (Resolve-Path -LiteralPath (Join-Path $project '../../node_modules/vitest/vitest.mjs')).Path
$node = (Get-Command node.exe -ErrorAction Stop).Source
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Security.Principal;

public static class LexoraPlatformTestProcess {
  [StructLayout(LayoutKind.Sequential)]
  private struct SecurityAttributes {
    public int Size;
    public IntPtr Descriptor;
    public int Inherit;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string text, uint version, out IntPtr descriptor, out uint size);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateWindowStation(string name, uint flags, uint access, ref SecurityAttributes attributes);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr mode, uint flags, uint access, ref SecurityAttributes attributes);
  [DllImport("user32.dll")] private static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll", SetLastError = true)] private static extern bool SetProcessWindowStation(IntPtr station);
  [DllImport("user32.dll")] private static extern bool CloseWindowStation(IntPtr station);
  [DllImport("user32.dll")] private static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr pointer);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct StartupInfo {
    public int Size;
    public string Reserved, Desktop, Title;
    public int X, Y, Width, Height, XChars, YChars, Fill, Flags;
    public short Show, ReservedSize;
    public IntPtr ReservedData, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct ProcessInfo {
    public IntPtr Process, Thread;
    public int Id, ThreadId;
  }
  [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] private static extern bool CreateRestrictedToken(IntPtr original, uint flags, uint disabledCount, IntPtr disabled, uint deletedCount, IntPtr deleted, uint restrictedCount, IntPtr restricted, out IntPtr token);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateProcessAsUser(IntPtr token, string application, StringBuilder command, ref SecurityAttributes processAttributes, ref SecurityAttributes threadAttributes, bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInfo process);
  [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetSecurityDescriptorDacl(IntPtr descriptor, out bool present, out IntPtr dacl, out bool defaulted);
  [DllImport("advapi32.dll", SetLastError = true)] private static extern bool SetTokenInformation(IntPtr token, int type, ref IntPtr value, uint length);
  [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr process, out int code);
  private static void Check(bool success) {
    if (!success) throw new Win32Exception(Marshal.GetLastWin32Error());
  }
  public static int Run(string executable, string arguments, string directory) {
    IntPtr original = IntPtr.Zero, restricted = IntPtr.Zero;
    IntPtr station = IntPtr.Zero, desktop = IntPtr.Zero, descriptor = IntPtr.Zero;
    var info = new ProcessInfo();
    try {
      const uint TokenAssignPrimary = 0x1, TokenDuplicate = 0x2, TokenQuery = 0x8, TokenAdjustDefault = 0x80;
      Check(OpenProcessToken(Process.GetCurrentProcess().Handle, TokenAssignPrimary | TokenDuplicate | TokenQuery | TokenAdjustDefault, out original));
      const uint DisableMaxPrivilege = 0x1, LuaToken = 0x4;
      Check(CreateRestrictedToken(original, DisableMaxPrivilege | LuaToken, 0, IntPtr.Zero, 0, IntPtr.Zero, 0, IntPtr.Zero, out restricted));
      uint descriptorSize;
      Check(ConvertStringSecurityDescriptorToSecurityDescriptor("D:(A;;GA;;;SY)(A;;GA;;;" + WindowsIdentity.GetCurrent().User.Value + ")", 1, out descriptor, out descriptorSize));
      bool present, defaulted;
      IntPtr dacl;
      Check(GetSecurityDescriptorDacl(descriptor, out present, out dacl, out defaulted));
      const int TokenDefaultDacl = 6;
      Check(SetTokenInformation(restricted, TokenDefaultDacl, ref dacl, (uint)IntPtr.Size));
      var attributes = new SecurityAttributes { Size = Marshal.SizeOf(typeof(SecurityAttributes)), Descriptor = descriptor };
      var stationName = "LexoraTests-" + Guid.NewGuid().ToString("N");
      const uint GenericAll = 0x10000000, CreateOnly = 0x1;
      station = CreateWindowStation(stationName, CreateOnly, GenericAll, ref attributes);
      Check(station != IntPtr.Zero);
      var previous = GetProcessWindowStation();
      Check(SetProcessWindowStation(station));
      try {
        desktop = CreateDesktop("Tests", IntPtr.Zero, IntPtr.Zero, 0, GenericAll, ref attributes);
        Check(desktop != IntPtr.Zero);
      } finally {
        Check(SetProcessWindowStation(previous));
      }
      var startup = new StartupInfo { Size = Marshal.SizeOf(typeof(StartupInfo)), Desktop = stationName + "\\Tests" };
      const uint CreateNoWindow = 0x08000000;
      Check(CreateProcessAsUser(restricted, executable, new StringBuilder("\"" + executable + "\" " + arguments), ref attributes, ref attributes, false, CreateNoWindow, IntPtr.Zero, directory, ref startup, out info));
      var wait = WaitForSingleObject(info.Process, 300000);
      const uint WaitTimeout = 258;
      if (wait == WaitTimeout) {
        using (var killer = Process.Start(new ProcessStartInfo(System.IO.Path.Combine(Environment.SystemDirectory, "taskkill.exe"), "/PID " + info.Id + " /T /F") { UseShellExecute = false, CreateNoWindow = true })) {
          killer.WaitForExit();
        }
        throw new TimeoutException("Windows platform tests timed out.");
      }
      Check(wait == 0);
      int code;
      Check(GetExitCodeProcess(info.Process, out code));
      return code;
    } finally {
      if (info.Thread != IntPtr.Zero) CloseHandle(info.Thread);
      if (info.Process != IntPtr.Zero) CloseHandle(info.Process);
      if (restricted != IntPtr.Zero) CloseHandle(restricted);
      if (original != IntPtr.Zero) CloseHandle(original);
      if (desktop != IntPtr.Zero) CloseDesktop(desktop);
      if (station != IntPtr.Zero) CloseWindowStation(station);
      if (descriptor != IntPtr.Zero) LocalFree(descriptor);
    }
  }
}
'@
$directory = Join-Path $env:TEMP ('lexora-platform-tests-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $directory | Out-Null
$log = Join-Path $directory 'result.log'
try {
  foreach ($file in $TestFiles) {
    if ($file -notmatch '^[a-zA-Z0-9_./-]+$') { throw "Invalid test file filter: $file" }
  }
  $command = @"
@echo off
cd /d "$project" || exit /b 1
"$node" "$vitest" run --maxWorkers=4 --project=platform --reporter=default $($TestFiles -join ' ') >> "$log" 2>&1
exit /b %errorlevel%
"@
  [IO.File]::WriteAllText((Join-Path $directory 'run.cmd'), $command, [Text.UTF8Encoding]::new($false))
  $script = @"
`$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath '$($directory.Replace("'", "''"))'
try {
  `$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  `$administrator = [Security.Principal.WindowsPrincipal]::new(`$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  "Test identity: `$(`$identity.Name); administrator: `$administrator" | Set-Content -LiteralPath 'result.log' -Encoding UTF8
  if (`$administrator) { throw 'Platform tests require a non-administrator token.' }
  & `$env:ComSpec /d /c run.cmd
  exit `$LASTEXITCODE
}
catch {
  `$_ | Out-String | Add-Content -LiteralPath 'result.log' -Encoding UTF8
  exit 1
}
"@
  $scriptPath = Join-Path $directory 'run.ps1'
  Set-Content -LiteralPath $scriptPath -Value $script -Encoding UTF8
  $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $result = [LexoraPlatformTestProcess]::Run($powershell, "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$scriptPath`"", $directory)
  if ($result -ne 0) { throw "Windows platform tests failed: $result" }
  if (-not (Test-Path -LiteralPath $log)) { throw 'Windows platform tests did not produce a report.' }
}
finally {
  if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log -Encoding UTF8 }
  Remove-Item -LiteralPath $directory -Recurse -Force
}
