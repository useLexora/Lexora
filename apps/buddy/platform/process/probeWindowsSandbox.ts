import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { createWindowsSandboxEnvironment } from './sandboxEnvironment'
import { runWindowsSandboxProcess } from './windowsSandboxProcess'

export async function probeWindowsSandbox(executable: string, shell: string): Promise<boolean> {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT
  if (!systemRoot)
    return false
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'lexora-sandbox-check-')))
  const listener = createServer(socket => socket.destroy())
  try {
    await Promise.all(['home', 'tmp'].map(path => mkdir(join(directory, path))))
    await new Promise<void>((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve))
    const address = listener.address()
    if (!address || typeof address === 'string')
      return false
    const paths = [directory]
    for (let parent = dirname(directory); !paths.includes(parent); parent = dirname(parent))
      paths.push(parent)
    const grants = await Promise.all(paths.map(async (path) => {
      const metadata = await stat(path, { bigint: true })
      return { path, inherit: path === directory, access: path === directory ? 'write' as const : 'read' as const, device: String(metadata.dev), inode: String(metadata.ino) }
    }))
    let output = ''
    const exitCode = await runWindowsSandboxProcess(executable, {
      command: '$ErrorActionPreference=\'Stop\'; if (!$PWD.Path -or $PWD.Path -ne [IO.Path]::GetDirectoryName($env:HOME)) { throw \'cwd\' }; $file=Join-Path $env:TEMP \'roundtrip\'; Set-Content -LiteralPath $file -Value \'probe\'; if ((Get-Content -LiteralPath $file -Raw).Trim() -ne \'probe\') { throw \'read\' }; Remove-Item -LiteralPath $file; if (Test-Path -LiteralPath $file) { throw \'delete\' }; & $env:ComSpec /d /c \'exit 0\'; if ($LASTEXITCODE -ne 0) { throw \'child\' }; [Console]::Out.Write(\'SANDBOX_PROBE_OK\')',
      cwd: directory,
      shell,
      privateRoot: directory,
      proxyPort: address.port,
      grants,
      environment: createWindowsSandboxEnvironment({ SystemRoot: systemRoot, USERPROFILE: join(directory, 'home') }, { shell, systemRoot, privateRoot: directory, path: [dirname(shell), join(systemRoot, 'System32')].join(';') }),
    }, { signal: AbortSignal.timeout(15_000), onData: (data) => { output = `${output}${data}`.slice(-4_096) }, onStarted: () => {} })
    return exitCode === 0 && output === 'SANDBOX_PROBE_OK'
  }
  finally {
    await new Promise<void>(resolve => listener.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
}
