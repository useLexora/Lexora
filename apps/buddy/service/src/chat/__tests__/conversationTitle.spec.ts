import type { BuddyInlineNodeV1 } from '../../../../shared/conversation/buddyUserContent'
import type { AttachmentRecord } from '../../storage/attachmentRepository'
import { describe, expect, it } from 'vitest'
import { buddyUserContentV1Schema } from '../../../../shared/conversation/buddyUserContent'
import { createConversationTitle } from '../conversationTitle'

function content(...body: BuddyInlineNodeV1[][]) {
  return buddyUserContentV1Schema.parse({
    body: body.map(nodes => ({ content: nodes, type: 'paragraph' })),
    panelResourceIds: [],
    version: 1,
  })
}

function attachment(name: string): AttachmentRecord {
  return { conversationId: null, createdAt: '2026-09-19T00:00:00.000Z', draftId: null, id: `attachment-${name}`, messageId: null, mimeType: 'application/octet-stream', name, sizeBytes: 1, storedPath: `/tmp/${name}` }
}

describe('conversation title derivation', () => {
  it('keeps only the typed text of the first message without resource echoes', () => {
    expect(createConversationTitle(content([
      { resourceId: 'pasted-image', type: 'resource_ref' },
      { text: ' 模型服务删除应该移除', type: 'text' },
    ]), [attachment('image.png')])).toBe('模型服务删除应该移除')
    expect(createConversationTitle(content([
      { text: '修复', type: 'text' },
      { resourceId: 'pasted-image', type: 'resource_ref' },
      { text: '的类型错误', type: 'text' },
    ]), [])).toBe('修复的类型错误')
  })

  it('collapses paragraphs and hard breaks and bounds the title length', () => {
    expect(createConversationTitle(content([{ text: '第一段', type: 'text' }], [{ text: '第二段', type: 'text' }, { type: 'hard_break' }, { text: '同行', type: 'text' }]), [])).toBe('第一段 第二段 同行')
    expect(createConversationTitle(content([{ text: '内'.repeat(120), type: 'text' }]), [])).toHaveLength(80)
  })

  it('falls back to attachment names only when the first message has no text', () => {
    expect(createConversationTitle(content([{ resourceId: 'pasted-image', type: 'resource_ref' }]), [attachment('/tmp/report/季度报告.pdf')])).toBe('季度报告.pdf')
    expect(createConversationTitle(content([{ resourceId: 'pasted-image', type: 'resource_ref' }]), [])).toBe('New conversation')
  })

  it('keeps user directives in the title', () => {
    expect(createConversationTitle(content([
      { directive: 'slash_command', commandMode: 'prompt', type: 'prompt_directive', value: '/plan' },
      { text: ' 整理发布步骤', type: 'text' },
    ]), [])).toBe('/plan 整理发布步骤')
  })
})
