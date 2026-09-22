import { describe, expect, it } from 'vitest'
import {
  buddyUserContentV1Schema,
  createBuddyUserContent,
  hasBuddyUserContent,
} from '../buddyUserContent'
import { projectBuddyUserContent } from '../buddyUserContentProjection'

const content = buddyUserContentV1Schema.parse({
  body: [{
    content: [
      { text: '比较 ', type: 'text' },
      { resourceId: 'image-a', type: 'resource_ref' },
      { text: ' 和 ', type: 'text' },
      { resourceId: 'image-b', type: 'resource_ref' },
      { text: '，再看 ', type: 'text' },
      { resourceId: 'image-a', type: 'resource_ref' },
    ],
    type: 'paragraph',
  }],
  panelResourceIds: ['notes', 'image-a'],
  version: 1,
})

describe('buddy user content', () => {
  it.each([
    { ...content, version: 2 },
    { ...content, extra: true },
    { ...content, panelResourceIds: ['image-a', 'image-a'] },
    { ...content, panelResourceIds: ['../../private'] },
    { ...content, body: [] },
    { ...content, body: [{ content: [], type: 'heading' }] },
    { ...content, body: [{ content: [{ type: 'image', url: '/private' }], type: 'paragraph' }] },
    { ...content, body: [{ content: [{ placementId: 'extra', resourceId: 'image-a', type: 'resource_ref' }], type: 'paragraph' }] },
    { ...content, body: [{ content: [{ directive: 'skill', commandMode: 'prompt', type: 'prompt_directive', value: 'review' }], type: 'paragraph' }] },
    { ...content, body: [{ content: [{ directive: 'slash_command', type: 'prompt_directive', value: '/review' }], type: 'paragraph' }] },
  ])('rejects unknown or ambiguous persisted structures: %j', (value) => {
    expect(buddyUserContentV1Schema.safeParse(value).success).toBe(false)
  })

  it('projects one stable image order, repeated markers, and the complete text appendix', () => {
    const projection = projectBuddyUserContent(content, resourceId => resourceId === 'notes'
      ? { kind: 'text', name: 'notes.md', text: '完整内容\n最后一行\n' }
      : { kind: 'image', name: `${resourceId}.png`, nameSource: 'clipboard' }, () => '')

    expect(projection).toEqual({
      imageResourceIds: ['image-a', 'image-b'],
      prompt: '[FILE#1]\n\n比较 [Image #1] 和 [Image #2]，再看 [Image #1]\n\n[FILE#1] "notes.md" (TEXT)\n完整内容\n最后一行\n\n\n[Image #1] "image-a.png" (IMAGE)\n\n[Image #2] "image-b.png" (IMAGE)',
      resources: [
        { kind: 'text', marker: '[FILE#1]', resourceId: 'notes' },
        { kind: 'image', marker: '[Image #1]', resourceId: 'image-a' },
        { kind: 'image', marker: '[Image #2]', resourceId: 'image-b' },
      ],
    })
  })

  it('keeps handwritten markers literal, including split text nodes and appendix content', () => {
    const projection = projectBuddyUserContent({
      ...content,
      body: [{
        content: [
          { text: '[IMA', type: 'text' },
          { text: 'GE#1] ', type: 'text' },
          { directive: 'skill', type: 'prompt_directive', value: 'review' },
          { resourceId: 'image-a', type: 'resource_ref' },
        ],
        type: 'paragraph',
      }],
    }, id => id === 'notes'
      ? { kind: 'text', name: '[FILE#7].txt', text: '[IMAGE#2]' }
      : { kind: 'image', name: 'a.png' }, () => '[FILE#4]')

    expect(projection.prompt).toBe('[FILE#1]\n\n［IMAGE#1］ ［FILE#4］[FILE#2]\n\n[FILE#1] "［FILE#7］.txt" (TEXT)\n［IMAGE#2］\n\n[FILE#2] "a.png" (IMAGE)')
  })

  it('does not discard unresolved resources or send action commands as model input', () => {
    expect(() => projectBuddyUserContent(content, () => {
      throw new Error('Resource unavailable')
    }, () => '')).toThrow('Resource unavailable')
    expect(() => projectBuddyUserContent({
      ...createBuddyUserContent(),
      body: [{
        content: [{ commandMode: 'action', directive: 'slash_command', type: 'prompt_directive', value: '/compact' }],
        type: 'paragraph',
      }],
    }, () => ({ kind: 'image', name: 'unused.png' }), () => '')).toThrow('Action commands')
  })

  it('accurately identifies whether content has user text, attachments, or quotes', () => {
    expect(hasBuddyUserContent(null)).toBe(false)
    expect(hasBuddyUserContent(undefined)).toBe(false)
    expect(hasBuddyUserContent(createBuddyUserContent(''))).toBe(false)
    expect(hasBuddyUserContent(createBuddyUserContent('   \n  '))).toBe(false)

    // Text content
    expect(hasBuddyUserContent(createBuddyUserContent('hello'))).toBe(true)

    // Panel resources
    expect(hasBuddyUserContent({ ...createBuddyUserContent(''), panelResourceIds: ['img-1'] })).toBe(true)

    // Quotes
    expect(hasBuddyUserContent({
      ...createBuddyUserContent(''),
      quotes: [{
        id: 'q1',
        text: 'quoted message',
        source: {
          conversationId: 'c1',
          branchId: 'b1',
          messageId: 'm1',
          role: 'user',
          runId: null,
        },
      }],
    })).toBe(true)
  })
})
