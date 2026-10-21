import type { SandboxProcessInput } from '../../../../../../shared/permissions/shellSandbox'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { describe, expect, it, vi } from 'vitest'
import { createSandboxDirectory } from '../../../../../../platform/process/sandboxDirectory'
import { createSandboxEnvironment } from '../../../../../../platform/process/sandboxEnvironment'
import { detectShellPrograms } from '../../../../../../platform/process/shellPrograms'
import { runSandboxCommand } from '../../../runSandboxCommand'

describe.skipIf(process.platform !== 'linux')('explicit shells through SRT', () => {
  it('retains quoting, multiline, exit status and denied writes for installed POSIX shells', async () => {
    const environment = { ...process.env }
    const buddyRoot = process.cwd()
    const candidates = (await detectShellPrograms()).filter(candidate => candidate.available && ['bash', 'sh', 'zsh'].includes(candidate.dialect))
    expect(candidates.some(candidate => candidate.id === 'bash')).toBe(true)
    const root = await mkdtemp(join(tmpdir(), 'lexora-shell-program-'))
    const workspace = join(root, 'workspace')
    const outside = join(root, 'outside')
    await mkdir(workspace)
    await writeFile(outside, 'preserved')
    try {
      for (const candidate of candidates) {
        const privateRoot = await createSandboxDirectory()
        try {
          const filtered = createSandboxEnvironment(environment, privateRoot)
          filtered.LEXORA_BUDDY_PROCESS_CONTROL = environment.LEXORA_BUDDY_PROCESS_CONTROL!
          for (const key of new Set([...Object.keys(process.env), ...Object.keys(filtered)]))
            vi.stubEnv(key, filtered[key])
          process.chdir(privateRoot)
          const input: SandboxProcessInput = {
            command: `printf '%s' '你好 "quoted"' > result\ncat result\nprintf denied > '${outside}'\nexit 7`,
            shell: { dialect: candidate.dialect, executable: candidate.executable },
            cwd: workspace,
            home: homedir(),
            privateRoot,
            readOnly: false,
            roots: [workspace],
            workspaceRoots: [workspace],
            resourceReadRoots: [],
            additionalDirectories: [],
            protectedRoots: [],
            sensitiveRoots: [],
            requestId: randomUUID(),
            timeout: 5,
            path: environment.PATH ?? '',
            searchDirectory: resolve(buddyRoot, `.output/build/search-tools/linux-${process.arch}`),
            backend: { kind: 'linux-srt', sandboxDirectory: resolve(buddyRoot, `.output/build/shell-sandbox/linux-${process.arch}`) },
          }
          const output: Buffer[] = []
          const result = await runSandboxCommand(input, {
            signal: new AbortController().signal,
            approveNetwork: async () => false,
            onData: data => output.push(data),
          })
          expect(result, Buffer.concat(output).toString()).toEqual({ ok: true, exitCode: 7 })
          expect(await readFile(join(workspace, 'result'), 'utf8')).toBe('你好 "quoted"')
          expect(await readFile(outside, 'utf8')).toBe('preserved')
        }
        finally {
          process.chdir(buddyRoot)
          vi.unstubAllEnvs()
          await rm(privateRoot, { recursive: true, force: true })
        }
      }
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
