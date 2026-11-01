import type { RunWslSearch, WslSearchProcess } from '../../../wsl/wslProcess'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition } from '@earendil-works/pi-coding-agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWslSearchExtension, WSL_SEARCH_EXTENSION } from '../wslSearchExtension'

const wslRoot = String.raw`\\wsl.localhost\Ubuntu-24.04\home\lenovo\code\Foo`

interface Registered { name: string, description: string, parameters: unknown, execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }> }

function register(cwd: string, run: RunWslSearch) {
  const tools = new Map<string, Registered>()
  createWslSearchExtension(cwd, run).factory({ registerTool: (tool: Registered) => tools.set(tool.name, tool) } as never)
  const call = (name: string, input: Record<string, unknown>, context: { cwd: string }) => tools.get(name)!.execute('call', input, undefined, undefined, context)
  return { tools, call }
}

describe('wsl search extension', () => {
  let local: string
  beforeEach(async () => {
    local = await mkdtemp(join(tmpdir(), 'wsl-ext-'))
  })
  afterEach(async () => {
    await rm(local, { recursive: true, force: true })
  })

  it('is named as a Lexora extension and keeps the built-in grep, find and ls definitions', () => {
    expect(WSL_SEARCH_EXTENSION).toMatch(/^lexora-/)
    const { tools } = register(local, vi.fn())
    for (const [name, builtin] of [['grep', createGrepToolDefinition(local)], ['find', createFindToolDefinition(local)], ['ls', createLsToolDefinition(local)]] as const) {
      expect(tools.get(name)?.description).toBe(builtin.description)
      expect(tools.get(name)?.parameters).toEqual(builtin.parameters)
    }
  })

  it('runs a search of a WSL directory inside that distribution', async () => {
    const requests: WslSearchProcess[] = []
    const run: RunWslSearch = async (request) => {
      requests.push(request)
    }
    const { call } = register(wslRoot, run)
    await call('grep', { pattern: 'needle', path: 'src' }, { cwd: wslRoot })
    await call('find', { pattern: '*.ts' }, { cwd: wslRoot })
    await call('ls', {}, { cwd: wslRoot }).catch(() => {})
    expect(requests.map(({ distribution, program }) => ({ distribution, program }))).toEqual([
      { distribution: 'Ubuntu-24.04', program: 'rg' },
      { distribution: 'Ubuntu-24.04', program: 'rg' },
      { distribution: 'Ubuntu-24.04', program: 'find' },
    ])
    expect(requests[0]!.args.slice(-3)).toEqual(['--', 'needle', '/home/lenovo/code/Foo/src'])
    expect(requests[2]!.args.slice(0, 2)).toEqual(['-H', '/home/lenovo/code/Foo'])
  })

  it('fails instead of walking \\\\wsl.localhost when the WSL side cannot run', async () => {
    const run: RunWslSearch = async () => {
      throw new Error('rg is not installed in the WSL distribution Ubuntu-24.04')
    }
    const { call } = register(wslRoot, run)
    await expect(call('grep', { pattern: 'needle' }, { cwd: wslRoot })).rejects.toThrow('rg is not installed')
    await expect(call('find', { pattern: '*' }, { cwd: wslRoot })).rejects.toThrow('rg is not installed')
    await expect(call('ls', {}, { cwd: wslRoot })).rejects.toThrow('rg is not installed')
  })

  it('leaves a directory outside WSL to the built-in tools', async () => {
    const run = vi.fn<RunWslSearch>()
    await writeFile(join(local, 'a.txt'), '')
    const { call } = register(local, run)
    expect((await call('ls', {}, { cwd: local })).content[0]!.text).toBe('a.txt')
    // A Linux path in a WSL session is not a WSL path to the file tools either; the built-in tool answers.
    await expect(call('ls', { path: join(local, 'missing') }, { cwd: wslRoot })).rejects.toThrow('Path not found')
    expect(run).not.toHaveBeenCalled()
  })
})
