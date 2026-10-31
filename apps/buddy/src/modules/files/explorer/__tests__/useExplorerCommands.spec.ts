import type { SpaceFileTarget } from '@buddy-shared/spaces/spaceFileApi'
import type { FileOperations } from '../../fileOperationsContext'
import type { ExplorerNode } from '@/shared/ui/explorer/treeCollection'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, shallowRef } from 'vue'
import { useExplorerCommands } from '../useExplorerCommands'

const { getOperations, messages } = vi.hoisted(() => ({ getOperations: vi.fn(), messages: [] as string[] }))
vi.mock('../../fileOperationsContext', () => ({ useFileOperations: getOperations }))
vi.mock('naive-ui', () => ({ useDialog: () => ({}), useMessage: () => ({ error: (text: string) => messages.push(text) }) }))

const cleanup: Array<() => void> = []
afterEach(() => {
  messages.length = 0
  for (const stop of cleanup.splice(0)) stop()
})
const target = { spaceId: 'space', directoryId: 'directory', revision: 1, path: '' }
const node: ExplorerNode = { key: '资料/合同 草稿.docx', label: '合同 草稿.docx', kind: 'file' }
const destination: ExplorerNode = { key: 'destination', label: 'destination', kind: 'directory' }

function fixture() {
  const systemClipboard = shallowRef('previous text')
  const operations = {
    clipboard: shallowRef<FileOperations['clipboard']['value']>(null),
    execute: vi.fn().mockResolvedValue({ status: 'applied' }),
  }
  const copyFilePath = vi.fn(async (input: SpaceFileTarget) => {
    systemClipboard.value = `/workspace/${input.path}`
  })
  getOperations.mockReturnValue(operations)
  const scope = effectScope()
  cleanup.push(() => scope.stop())
  const commands = scope.run(() => useExplorerCommands({
    target: () => target,
    language: () => 'zh-CN',
    api: { revealFile: vi.fn(), copyFilePath, cancelFileOperation: vi.fn() },
    refresh: vi.fn().mockResolvedValue(undefined),
  }))!
  return { operations, commands, copyFilePath, systemClipboard }
}

describe('explorer clipboard commands', () => {
  it.each(['copy', 'cut'])('preserves system text while using %s for file paste', async (command) => {
    const { operations, commands, systemClipboard } = fixture()
    await commands.command(command, node)
    expect(systemClipboard.value).toBe('previous text')
    expect(operations.clipboard.value).toEqual({ target: { ...target, path: node.key }, move: command === 'cut' })
    await commands.command('paste', destination)
    expect(operations.execute).toHaveBeenCalledWith(expect.objectContaining({
      path: node.key,
      action: { kind: command === 'cut' ? 'move' : 'copy', destination: { ...target, path: 'destination/合同 草稿.docx' } },
    }))
    expect(systemClipboard.value).toBe('previous text')
    if (command === 'cut')
      expect(operations.clipboard.value).toBeNull()
  })

  it('copies path text without replacing a pending file cut', async () => {
    const { operations, commands, copyFilePath, systemClipboard } = fixture()
    await commands.command('cut', node)
    const pending = operations.clipboard.value
    await commands.command('copyPath', destination)
    expect(copyFilePath).toHaveBeenCalledExactlyOnceWith({ ...target, path: 'destination' })
    expect(systemClipboard.value).toBe('/workspace/destination')
    expect(operations.clipboard.value).toBe(pending)
    await commands.command('paste', destination)
    expect(operations.execute).toHaveBeenCalledWith(expect.objectContaining({
      path: node.key,
      action: { kind: 'move', destination: { ...target, path: 'destination/合同 草稿.docx' } },
    }))
  })

  it('keeps both clipboards on failure and clears the path error after retry', async () => {
    const { operations, commands, copyFilePath, systemClipboard } = fixture()
    await commands.command('copy', node)
    const pending = operations.clipboard.value
    copyFilePath.mockRejectedValueOnce(new Error('clipboard unavailable'))
    await commands.command('copyPath', destination)
    expect(messages).toEqual(['复制路径失败，请重试。'])
    expect(systemClipboard.value).toBe('previous text')
    expect(operations.clipboard.value).toBe(pending)
    await commands.command('copyPath', destination)
    expect(messages).toEqual(['复制路径失败，请重试。'])
    expect(systemClipboard.value).toBe('/workspace/destination')
    expect(operations.clipboard.value).toBe(pending)
  })

  it('ignores missing and disabled nodes', async () => {
    const { operations, commands, systemClipboard } = fixture()
    for (const command of ['copy', 'cut', 'copyPath']) {
      await commands.command(command, null)
      await commands.command(command, { ...node, disabled: true })
    }
    expect(systemClipboard.value).toBe('previous text')
    expect(operations.clipboard.value).toBeNull()
    expect(messages).toEqual([])
  })
})
