import type { SpawnWsl } from '../wslProcess'
import { Buffer } from 'node:buffer'
import { spawn, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runWslSearch } from '../wslProcess'
import { executeWslFind, executeWslGrep, executeWslLs, resolveWslPath, wslUncPath } from '../wslSearch'

const distribution = 'Ubuntu-24.04'
const wslRoot = String.raw`\\wsl.localhost\Ubuntu-24.04\home\lenovo\code\Foo`

describe('resolveWslPath', () => {
  it('defaults to the working directory and resolves relative paths inside the distribution', () => {
    expect(resolveWslPath(undefined, wslRoot)).toEqual({ distribution, linuxPath: '/home/lenovo/code/Foo' })
    expect(resolveWslPath('src/a', wslRoot)).toEqual({ distribution, linuxPath: '/home/lenovo/code/Foo/src/a' })
    expect(resolveWslPath(String.raw`src\a`, wslRoot)).toEqual({ distribution, linuxPath: '/home/lenovo/code/Foo/src/a' })
    expect(resolveWslPath('@src', wslRoot)).toEqual({ distribution, linuxPath: '/home/lenovo/code/Foo/src' })
    expect(resolveWslPath('../Bar', wslRoot)).toEqual({ distribution, linuxPath: '/home/lenovo/code/Bar' })
  })

  it('takes absolute \\\\wsl.localhost and \\\\wsl$ paths in any distribution, with either slash', () => {
    expect(resolveWslPath('//wsl.localhost/Ubuntu-24.04/tmp/x', 'C:\\work')).toEqual({ distribution, linuxPath: '/tmp/x' })
    expect(resolveWslPath(String.raw`\\wsl$\Debian\var\log`, wslRoot)).toEqual({ distribution: 'Debian', linuxPath: '/var/log' })
  })

  it('leaves everything that is not WSL to the built-in tools', () => {
    expect(resolveWslPath(undefined, 'C:\\work')).toBeNull()
    expect(resolveWslPath('src', 'C:\\work')).toBeNull()
    expect(resolveWslPath('/home/lenovo/code/Foo', wslRoot)).toBeNull()
    expect(resolveWslPath('C:\\work', wslRoot)).toBeNull()
    expect(resolveWslPath(String.raw`\\server\share`, wslRoot)).toBeNull()
    expect(resolveWslPath('~/notes', wslRoot)).toBeNull()
  })

  it('shows a target in the path form the file tools use', () => {
    expect(wslUncPath({ distribution, linuxPath: '/home/lenovo' })).toBe(String.raw`\\wsl.localhost\Ubuntu-24.04\home\lenovo`)
  })
})

function fakeChild() {
  return Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() })
}

function scripted(output: { stdout?: Buffer, stderr?: Buffer, code: number }, calls: string[][] = []): SpawnWsl {
  return (_executable, args) => {
    calls.push(args)
    const child = fakeChild()
    setImmediate(() => {
      if (output.stdout)
        child.stdout.write(output.stdout)
      if (output.stderr)
        child.stderr.write(output.stderr)
      setImmediate(() => child.emit('close', output.code))
    })
    return child as unknown as ReturnType<SpawnWsl>
  }
}

function noRecords() {}
function search(spawnProcess: SpawnWsl, program = 'rg') {
  return runWslSearch({ distribution, program, args: ['--', 'a"b $x'], separator: 10, successCodes: [0, 1], onRecord: noRecords, spawnProcess })
}

describe('runWslSearch', () => {
  it('starts the program through wsl.exe --exec with every argument as its own element', async () => {
    const calls: string[][] = []
    await search(scripted({ code: 1 }, calls))
    expect(calls).toEqual([['-d', distribution, '--exec', 'rg', '--', 'a"b $x']])
  })

  it('names the missing program even though wsl.exe exits with a success code', async () => {
    const stderr = Buffer.from('<3>WSL (1086755 - Relay) ERROR: CreateProcessCommon:875: execvpe(rg) failed: No such file or directory')
    await expect(search(scripted({ stderr, code: 1 }))).rejects.toThrow('rg is not installed in the WSL distribution Ubuntu-24.04; install ripgrep there (sudo apt install ripgrep)')
    await expect(search(scripted({ stderr: Buffer.from(stderr.toString().replace('rg', 'find')), code: 1 }), 'find')).rejects.toThrow('find is not installed in the WSL distribution Ubuntu-24.04')
  })

  it('reports a wsl.exe error that arrives as UTF-16 text on stdout', async () => {
    const stdout = Buffer.from('There is no distribution with the supplied name.\r\n', 'utf16le')
    await expect(search(scripted({ stdout, code: 4294967295 }))).rejects.toThrow('wsl.exe failed: There is no distribution with the supplied name.')
  })

  it('reports a wsl.exe error written in the system language, from grep and from ls', async () => {
    const stdout = Buffer.from('不存在具有所提供名称的分发。\r\nError code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND\r\n')
    const missing = { distribution: 'No-Such-Distro', linuxPath: '/tmp' }
    await expect(executeWslGrep(missing, { pattern: 'x' }, undefined, request => runWslSearch({ ...request, spawnProcess: scripted({ stdout, code: 4294967295 }) }))).rejects.toThrow('wsl.exe failed: 不存在具有所提供名称的分发。')
    await expect(executeWslLs(missing, {}, undefined, request => runWslSearch({ ...request, spawnProcess: scripted({ stdout, code: 4294967295 }) }))).rejects.toThrow('不存在具有所提供名称的分发。')
    await expect(executeWslFind(missing, { pattern: '*' }, undefined, request => runWslSearch({ ...request, spawnProcess: scripted({ stdout, code: 4294967295 }) }))).rejects.toThrow('不存在具有所提供名称的分发。')
  })

  it('reports the diagnostics of a program that fails', async () => {
    await expect(search(scripted({ stderr: Buffer.from('rg: regex parse error\n'), code: 2 }))).rejects.toThrow('rg: regex parse error')
  })

  it('stops reading and succeeds when the record handler asks for it', async () => {
    const spawnProcess = scripted({ stdout: Buffer.from('a\nb\nc\n'), code: 0 })
    const seen: string[] = []
    await runWslSearch({
      distribution,
      program: 'rg',
      args: [],
      separator: 10,
      successCodes: [0],
      spawnProcess,
      onRecord(record) {
        seen.push(record.toString())
        return seen.length < 2
      },
    })
    expect(seen).toEqual(['a', 'b'])
  })

  it('rejects when already aborted without starting a process', async () => {
    const calls: string[][] = []
    await expect(runWslSearch({ distribution, program: 'rg', args: [], separator: 10, successCodes: [0], onRecord: noRecords, signal: AbortSignal.abort(), spawnProcess: scripted({ code: 0 }, calls) })).rejects.toThrow()
    expect(calls).toEqual([])
  })
})

// A shim that runs `wsl.exe -d <distribution> --exec <program> <args>` as a local process, so the output parsing
// is checked against real rg and find. They are Linux tools, hence the skips elsewhere.
const localSpawn: SpawnWsl = (_executable, args) => {
  const [, , , program, ...rest] = args
  return spawn(program!, rest, { stdio: ['ignore', 'pipe', 'pipe'] }) as unknown as ReturnType<SpawnWsl>
}
const run = (request: Parameters<typeof runWslSearch>[0]) => runWslSearch({ ...request, spawnProcess: localSpawn })
const hasRipgrep = process.platform !== 'win32' && spawnSync('rg', ['--version']).status === 0
const hasGnuFind = process.platform !== 'win32' && spawnSync('find', ['.', '-maxdepth', '0', '-printf', 'x']).status === 0

function text(result: { content: { text: string }[] }) {
  return result.content.map(item => item.text).join('\n')
}

let root: string
let target: { distribution: string, linuxPath: string }
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wsl-search-'))
  target = { distribution, linuxPath: root }
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe.skipIf(!hasRipgrep)('executeWslGrep', () => {
  it('lists matches relative to the searched directory', async () => {
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', '文档.txt'), 'one\nneedle here\n')
    await writeFile(join(root, 'other.txt'), 'nothing\n')
    expect(text(await executeWslGrep(target, { pattern: 'needle' }, undefined, run))).toBe('src/文档.txt:2: needle here')
  })

  it('shows only the file name when the searched path is a file', async () => {
    await writeFile(join(root, 'a.txt'), 'needle\n')
    expect(text(await executeWslGrep({ ...target, linuxPath: join(root, 'a.txt') }, { pattern: 'needle' }, undefined, run))).toBe('a.txt:1: needle')
  })

  it('takes context lines from the same stream', async () => {
    await writeFile(join(root, 'a.txt'), 'before\r\nneedle\r\nafter\r\n')
    const output = text(await executeWslGrep(target, { pattern: 'needle', context: 1 }, undefined, run))
    expect(output).toBe('a.txt-1- before\na.txt:2: needle\na.txt-3- after')
  })

  it('passes the pattern, glob and flags to rg unchanged', async () => {
    await writeFile(join(root, 'a.ts'), 'A.b(c) "q" $x\n')
    await writeFile(join(root, 'a.md'), 'A.b(c) "q" $x\n')
    expect(text(await executeWslGrep(target, { pattern: 'a.b(c) "q" $x', literal: true, ignoreCase: true, glob: '*.ts' }, undefined, run))).toBe('a.ts:1: A.b(c) "q" $x')
  })

  it('never searches .git, even when a glob would let it in', async () => {
    await mkdir(join(root, '.git', 'pr-worktrees', 'x'), { recursive: true })
    await writeFile(join(root, '.git', 'pr-worktrees', 'x', 'copy.ts'), 'needle\n')
    await writeFile(join(root, 'real.ts'), 'needle\n')
    expect(text(await executeWslGrep(target, { pattern: 'needle', glob: '**/*.ts' }, undefined, run))).toBe('real.ts:1: needle')
  })

  it('honors .gitignore inside a repository', async () => {
    await mkdir(join(root, '.git'))
    await writeFile(join(root, '.gitignore'), 'generated/\n')
    await mkdir(join(root, 'generated'))
    await writeFile(join(root, 'generated', 'a.txt'), 'needle\n')
    expect(text(await executeWslGrep(target, { pattern: 'needle' }, undefined, run))).toBe('No matches found')
    expect(text(await executeWslGrep({ ...target, linuxPath: join(root, 'generated') }, { pattern: 'needle' }, undefined, run))).toBe('a.txt:1: needle')
  })

  it('clips a long line after matching all of it', async () => {
    await writeFile(join(root, 'long.txt'), `${'x'.repeat(100_000)}needle\n`)
    const result = await executeWslGrep(target, { pattern: 'needle' }, undefined, run)
    expect(text(result)).toContain('long.txt:1:')
    expect(text(result).length).toBeLessThan(2048)
    expect(result.details).toMatchObject({ linesTruncated: true })
  })

  it('stops at the match limit and says so', async () => {
    await writeFile(join(root, 'a.txt'), 'needle\n'.repeat(5))
    const result = await executeWslGrep(target, { pattern: 'needle', limit: 2 }, undefined, run)
    expect(text(result)).toBe('a.txt:1: needle\na.txt:2: needle\n\n[2 matches limit reached; narrow the path or pattern]')
    expect(result.details).toEqual({ matchLimitReached: 2 })
  })

  it('keeps an invalid pattern, a missing path and cancellation distinct from no matches', async () => {
    await expect(executeWslGrep(target, { pattern: '[' }, undefined, run)).rejects.toThrow('regex parse error')
    await expect(executeWslGrep({ ...target, linuxPath: join(root, 'missing') }, { pattern: 'x' }, undefined, run)).rejects.toThrow(`Path not found: ${wslUncPath({ ...target, linuxPath: join(root, 'missing') })}`)
    await expect(executeWslGrep(target, { pattern: 'x' }, AbortSignal.abort(), run)).rejects.toThrow()
  })
})

describe.skipIf(!hasRipgrep)('executeWslFind', () => {
  it('lists matching files relative to the searched directory, skipping .git', async () => {
    await mkdir(join(root, 'src', 'deep'), { recursive: true })
    await mkdir(join(root, '.git', 'pr-worktrees'), { recursive: true })
    await writeFile(join(root, 'src', 'a.ts'), '')
    await writeFile(join(root, 'src', 'deep', 'b.ts'), '')
    await writeFile(join(root, 'notes.md'), '')
    await writeFile(join(root, '.git', 'pr-worktrees', 'c.ts'), '')
    const lines = async (pattern: string) => text(await executeWslFind(target, { pattern }, undefined, run)).split('\n').sort()
    expect(await lines('*.ts')).toEqual(['src/a.ts', 'src/deep/b.ts'])
    expect(await lines('src/**/*.ts')).toEqual(['src/a.ts', 'src/deep/b.ts'])
    expect(await lines('deep/*.ts')).toEqual(['src/deep/b.ts'])
  })

  it('keeps file names with whitespace and newlines whole', async () => {
    const name = ' leading\ntrailing '
    await writeFile(join(root, name), '')
    expect(text(await executeWslFind(target, { pattern: '*' }, undefined, run))).toBe(name)
  })

  it('reports no match, the result limit and a missing path', async () => {
    await writeFile(join(root, 'a.txt'), '')
    await writeFile(join(root, 'b.txt'), '')
    expect(text(await executeWslFind(target, { pattern: '*.zip' }, undefined, run))).toBe('No files found matching pattern')
    const limited = await executeWslFind(target, { pattern: '*.txt', limit: 1 }, undefined, run)
    expect(text(limited)).toMatch(/^[ab]\.txt\n\n\[1 results limit reached; narrow the path or pattern\]$/)
    expect(limited.details).toEqual({ resultLimitReached: 1 })
    await expect(executeWslFind({ ...target, linuxPath: join(root, 'missing') }, { pattern: '*' }, undefined, run)).rejects.toThrow('Path not found')
  })
})

describe.skipIf(!hasGnuFind)('executeWslLs', () => {
  it('sorts case-insensitively, marks directories and keeps dotfiles', async () => {
    await mkdir(join(root, 'Zeta'))
    await mkdir(join(root, 'beta'))
    await writeFile(join(root, 'alpha.txt'), '')
    await writeFile(join(root, '.hidden'), '')
    expect(text(await executeWslLs(target, {}, undefined, run))).toBe('.hidden\nalpha.txt\nbeta/\nZeta/')
  })

  it('follows a link to a directory and skips a broken link', async () => {
    await mkdir(join(root, 'real'))
    await symlink(join(root, 'real'), join(root, 'link'))
    await symlink(join(root, 'nowhere'), join(root, 'broken'))
    expect(text(await executeWslLs(target, {}, undefined, run))).toBe('link/\nreal/')
  })

  it.skipIf(process.getuid?.() === 0)('tells a directory that cannot be read from one that does not exist', async () => {
    await mkdir(join(root, 'locked'))
    await chmod(join(root, 'locked'), 0)
    try {
      await expect(executeWslLs({ ...target, linuxPath: join(root, 'locked') }, {}, undefined, run)).rejects.toThrow('Cannot read directory')
    }
    finally {
      await chmod(join(root, 'locked'), 0o700)
    }
  })

  it('reports an empty directory, a file, a missing path and the entry limit', async () => {
    expect(text(await executeWslLs(target, {}, undefined, run))).toBe('(empty directory)')
    await writeFile(join(root, 'a.txt'), '')
    await writeFile(join(root, 'b.txt'), '')
    await expect(executeWslLs({ ...target, linuxPath: join(root, 'a.txt') }, {}, undefined, run)).rejects.toThrow('Not a directory')
    await expect(executeWslLs({ ...target, linuxPath: join(root, 'missing') }, {}, undefined, run)).rejects.toThrow('Path not found')
    const limited = await executeWslLs(target, { limit: 1 }, undefined, run)
    expect(text(limited)).toBe('a.txt\n\n[1 entries limit reached. Use limit=2 for more]')
    expect(limited.details).toEqual({ entryLimitReached: 1 })
  })
})
