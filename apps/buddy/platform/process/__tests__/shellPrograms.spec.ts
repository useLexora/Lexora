import { Buffer } from 'node:buffer'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { shellCandidateIdSchema, shellCandidateSchema, shellProgramSchema } from '../../../shared/shell/shellProgram'
import { buildShellInvocation, createShellProgramEnvironment, detectShellPrograms } from '../shellPrograms'
import { runSupervisedShellProcess } from '../supervisedShellProcess'

describe('shell program protocol', () => {
  it('keeps source as a single argument and uses dialect-specific noninteractive flags', () => {
    const command = 'printf "%s\\n" "quoted";\nprintf second'
    expect(buildShellInvocation({ dialect: 'bash', executable: '/bin/bash' }, command)).toEqual({
      shell: '/bin/bash',
      args: ['--noprofile', '--norc', '-c'],
      command,
    })
    expect(buildShellInvocation({ dialect: 'zsh', executable: '/bin/zsh' }, command).args).toEqual(['-f', '-c'])
    expect(buildShellInvocation({ dialect: 'sh', executable: '/bin/sh' }, command).args).toEqual(['-c'])
    expect(shellProgramSchema.safeParse({ dialect: 'bash', executable: 'bash' }).success).toBe(false)
    expect(shellProgramSchema.safeParse({ dialect: 'cmd', executable: 'C:\\Windows\\System32\\cmd.exe' }).success).toBe(true)
  })

  it('encodes PowerShell losslessly and rejects CMD multiline instead of truncating', () => {
    const command = 'Write-Output "你好";\nexit 7'
    const invocation = buildShellInvocation({ dialect: 'powershell', executable: '/usr/bin/pwsh' }, command)
    expect(invocation.args).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand'])
    expect(Buffer.from(invocation.command, 'base64').toString('utf16le')).toBe(command)
    expect(() => buildShellInvocation({ dialect: 'cmd', executable: 'C:\\Windows\\System32\\cmd.exe' }, 'echo first\necho second')).toThrow('CMD_MULTILINE_UNSUPPORTED')
  })

  it('returns the fixed candidate set and honors missing explicit executables without fallback', async () => {
    const configured = Object.fromEntries(shellCandidateIdSchema.options.map(id => [id, '/__lexora_missing_shell__/shell']))
    const candidates = await detectShellPrograms({ configured })
    expect(candidates.map(candidate => candidate.id)).toEqual(shellCandidateIdSchema.options)
    for (const candidate of candidates) {
      expect(shellCandidateSchema.parse(candidate)).toEqual(candidate)
      expect(candidate.available).toBe(false)
      expect(candidate.executable).toBe('')
    }
  })

  it('removes implicit startup code without dropping explicit host tool paths', () => {
    const environment = createShellProgramEnvironment({ dialect: 'bash', executable: 'C:\\Program Files\\Git\\bin\\bash.exe' }, {
      'Path': 'C:\\tools',
      'bash_env': 'C:\\startup.sh',
      'ENV': 'C:\\startup.sh',
      'ZDOTDIR': 'C:\\profile',
      'SHELLOPTS': 'xtrace',
      'BASH_FUNC_injected%%': '() { echo injected; }',
      'CUSTOM': 'preserved',
    }, 'win32')
    expect(environment).toEqual({ CUSTOM: 'preserved', PATH: expect.any(String) })
    expect(environment.PATH?.split(';')).toContain('C:\\Program Files\\Git\\usr\\bin')
    expect(environment.PATH?.split(';')).toContain('C:\\tools')
  })

  it('honors cancellation before detection', async () => {
    await expect(detectShellPrograms({ signal: AbortSignal.abort() })).rejects.toThrow()
  })
})

describe.skipIf(process.platform !== 'linux')('installed shells under native supervision', () => {
  it('preserves quotes, multiline, Unicode and explicit exit codes without changing shell', async () => {
    const candidates = await detectShellPrograms()
    for (const candidate of candidates.filter(candidate => candidate.available && ['bash', 'sh', 'zsh'].includes(candidate.dialect))) {
      const chunks: Buffer[] = []
      const settlements: string[] = []
      const result = await runSupervisedShellProcess({
        ...buildShellInvocation(candidate, 'printf "%s\\n" "你好 \' quote \\" double \\$ literal"\nprintf "%s" "line two"\nexit 7'),
        cwd: process.cwd(),
        environment: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      }, {
        onData: data => chunks.push(data),
        onSettlement: (record) => { settlements.push(record.settlement) },
      })
      expect(result.exitCode).toBe(7)
      expect(Buffer.concat(chunks).toString()).toBe('你好 \' quote " double $ literal\nline two')
      expect(settlements.at(-1)).toBe('released')
    }
    expect(candidates.some(candidate => candidate.id === 'bash' && candidate.available)).toBe(true)
  })
})
