import type { LocalConversationTimelinePage } from '@buddy-shared/conversation/conversationApi'
import { deferred } from '@buddy-tests/deferred'
import { describe, expect, it, vi } from 'vitest'
import { conversation, event, message, page, run, terminal } from '@/modules/tasks/model/transcript/__tests__/conversationMarkdownFixtures'
import { ConversationExportSizeError } from '@/modules/tasks/model/transcript/conversationMarkdown'
import { createConversationExport } from '../conversationExport'

function fixture(pages: LocalConversationTimelinePage[] = [page()]) {
  const get = vi.fn().mockResolvedValue(conversation())
  const listTimeline = vi.fn()
  for (const value of pages)
    listTimeline.mockResolvedValueOnce(value)
  const writeText = vi.fn().mockResolvedValue(undefined)
  const options = { api: { get, listTimeline }, clipboard: { writeText } }
  return { get, listTimeline, writeText, options, exporter: createConversationExport(options) }
}

describe('conversation export', () => {
  it('reads all pages on a fixed branch, keeps first run snapshots and copies exactly once', async () => {
    const firstRun = run()
    const firstEvent = event(1, 'tool.completed', { toolCallId: 'call', toolName: 'powershell', presentation: terminal('LATEST_LOG') })
    const answer = message('answer', 'assistant', 'ANSWER')
    const f = fixture([
      page({ items: [answer], nextCursor: 'older', runs: [firstRun], runEvents: [firstEvent] }),
      page({ items: [message('user', 'user', 'OLD_QUESTION', { branchId: 'ancestor' }), answer], runs: [run({ status: 'running' })], runEvents: [event(1, 'tool.completed', { ...firstEvent.payload, presentation: terminal('STALE_LOG') }), event(2, 'message.delta', { messageId: 'late', delta: 'LATE_EVENT' })] }),
    ])
    expect(await f.exporter.copy('conversation', 'fallback', 'en-US')).toEqual({ title: '排查启动失败' })
    expect(f.listTimeline.mock.calls.map(call => call[0])).toEqual([
      { conversationId: 'conversation', branchId: 'branch', cursor: undefined, limit: 500 },
      { conversationId: 'conversation', branchId: 'branch', cursor: 'older', limit: 500 },
    ])
    expect(f.get).toHaveBeenNthCalledWith(2, 'conversation')
    expect(f.writeText).toHaveBeenCalledTimes(1)
    const output = f.writeText.mock.calls[0]![0] as string
    expect(output.indexOf('OLD_QUESTION')).toBeLessThan(output.indexOf('ANSWER'))
    expect(output.match(/ANSWER/g)).toHaveLength(1)
    expect(output).toContain('LATEST_LOG')
    expect(output).not.toContain('STALE_LOG')
    expect(output).not.toContain('LATE_EVENT')
    expect(output).toContain('Status: completed')
    expect(f.exporter.busy.value).toBe(false)
  })

  it('rejects overlapping calls across menus and releases the shared lock', async () => {
    const waiting = deferred<LocalConversationTimelinePage>()
    const f = fixture()
    f.listTimeline.mockReset().mockReturnValue(waiting.promise)
    const copy = f.exporter.copy('conversation', 'first', 'en-US')
    expect(f.exporter.busy.value).toBe(true)
    expect(await f.exporter.copy('different', 'second', 'zh-CN')).toBeNull()
    waiting.resolve(page())
    await copy
    expect(f.get.mock.calls.every(call => call[0] === 'conversation')).toBe(true)
    expect(f.writeText).toHaveBeenCalledTimes(1)
    expect(f.exporter.busy.value).toBe(false)
  })

  it('does not change branch when the target active branch changes during reading', async () => {
    const f = fixture([page({ items: [message('user', 'user', 'ORIGINAL')], nextCursor: 'older' }), page()])
    f.get.mockResolvedValueOnce(conversation()).mockResolvedValue(conversation({ activeBranchId: 'new-branch' }))
    await f.exporter.copy('conversation', 'fallback', 'en-US')
    expect(f.listTimeline.mock.calls.every(call => call[0].branchId === 'branch')).toBe(true)
    expect(f.writeText.mock.calls[0]![0]).toContain('Branch ID: branch')
  })

  it('fails on a repeated cursor rather than silently exporting partial history', async () => {
    const f = fixture([page({ nextCursor: 'same' }), page({ nextCursor: 'same' })])
    await expect(f.exporter.copy('conversation', 'fallback', 'en-US')).rejects.toThrow('pagination')
    expect(f.writeText).not.toHaveBeenCalled()
    expect(f.listTimeline).toHaveBeenCalledTimes(2)
    expect(f.exporter.busy.value).toBe(false)
  })

  it('preserves the clipboard on a later page failure and allows retry', async () => {
    const f = fixture([page({ nextCursor: 'older' })])
    f.listTimeline.mockRejectedValueOnce(new Error('offline'))
    await expect(f.exporter.copy('conversation', 'fallback', 'en-US')).rejects.toThrow('offline')
    expect(f.writeText).not.toHaveBeenCalled()
    expect(f.exporter.busy.value).toBe(false)
    f.listTimeline.mockResolvedValue(page())
    await f.exporter.copy('conversation', 'fallback', 'en-US')
    expect(f.writeText).toHaveBeenCalledTimes(1)
  })

  it.each(['read', 'markdown'])('enforces the %s budget without writing a partial result', async (budget) => {
    const f = fixture([page({ items: [message('user', 'user', '中'.repeat(100))], nextCursor: 'older' })])
    const exporter = createConversationExport({ ...f.options, ...(budget === 'read' ? { maxReadBytes: 10 } : { maxMarkdownBytes: 10 }) })
    if (budget === 'markdown')
      f.listTimeline.mockResolvedValueOnce(page())
    await expect(exporter.copy('conversation', 'fallback', 'en-US')).rejects.toThrow(ConversationExportSizeError)
    expect(f.writeText).not.toHaveBeenCalled()
    expect(exporter.busy.value).toBe(false)
    if (budget === 'read')
      expect(f.listTimeline).toHaveBeenCalledTimes(1)
  })

  it('checks deletion again before writing', async () => {
    const f = fixture()
    f.get.mockResolvedValueOnce(conversation()).mockResolvedValueOnce(conversation({ deletedAt: '2026-10-21T09:00:00.000Z' }))
    await expect(f.exporter.copy('conversation', 'fallback', 'en-US')).rejects.toThrow('no longer available')
    expect(f.writeText).not.toHaveBeenCalled()
  })

  it('handles an empty branch without requesting a timeline and uses fallback titles', async () => {
    const f = fixture()
    f.get.mockResolvedValue(conversation({ activeBranchId: null, title: null }))
    await f.exporter.copy('conversation', 'fallback title', 'en-US')
    expect(f.listTimeline).not.toHaveBeenCalled()
    expect(f.writeText.mock.calls[0]![0]).toContain('# fallback title')
    expect(f.writeText.mock.calls[0]![0]).toContain('_No messages._')
  })

  it('propagates clipboard failures and releases the lock', async () => {
    const f = fixture()
    f.writeText.mockRejectedValueOnce(new Error('clipboard unavailable'))
    await expect(f.exporter.copy('conversation', 'fallback', 'en-US')).rejects.toThrow('clipboard unavailable')
    expect(f.exporter.busy.value).toBe(false)
  })
})
