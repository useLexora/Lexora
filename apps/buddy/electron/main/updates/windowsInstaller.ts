import { join } from 'node:path'
import process from 'node:process'
import { z } from 'zod'
import { runNativeCommand } from '../../../platform/native/nativeCommand'
import { createChildProcessEnvironment } from '../../../platform/process/childProcessEnvironment'
import { validateWindowsFilePath } from '../../../platform/windows/filePath'

const launchScript = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$startup = ([wmiclass]'Win32_ProcessStartup').CreateInstance()
$startup.EnvironmentVariables = [string[]]@($request.environment.psobject.Properties | ForEach-Object { $_.Name + '=' + [string]$_.Value })
$startup.ShowWindow = 1
$startup.WinstationDesktop = 'WinSta0\\Default'
$result = ([wmiclass]'Win32_Process').Create(('"' + [string]$request.path + '" /S --updated'), $request.directory, $startup)
if ($result.ReturnValue -ne 0) { throw 'UPDATE_INSTALL_UNAVAILABLE' }
$created = Get-WmiObject Win32_Process -Filter ('ProcessId = ' + $result.ProcessId)
if (!$created -or $created.SessionId -ne [Diagnostics.Process]::GetCurrentProcess().SessionId -or $created.GetOwnerSid().Sid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) {
  if ($created -and [string]::Equals($created.ExecutablePath, $request.path, [StringComparison]::OrdinalIgnoreCase)) { $null = $created.Terminate(1) }
  throw 'UPDATE_INSTALL_SESSION_CHANGED'
}
@{ pid = [int]$result.ProcessId } | ConvertTo-Json -Compress
`

export async function launchWindowsUpdateInstaller(path: string): Promise<void> {
  if (!process.env.SystemRoot)
    throw new Error('UPDATE_INSTALL_UNAVAILABLE')
  const executable = validateWindowsFilePath(path)
  const environment = createChildProcessEnvironment({ source: process.env, additions: { LEXORA_HOME: process.env.LEXORA_HOME, LEXORA_BUDDY_PROFILE: process.env.LEXORA_BUDDY_PROFILE } })
  const result = await runNativeCommand(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', launchScript], { path: executable, directory: process.env.SystemRoot, environment }, { env: environment, timeoutMs: 15000, maxBytes: 16384 })
  try {
    if (result.code === 0 && z.object({ pid: z.number().int().positive() }).strict().safeParse(JSON.parse(result.stdout.toString('utf8'))).success)
      return
  }
  catch {}
  throw new Error('UPDATE_INSTALL_UNAVAILABLE')
}
