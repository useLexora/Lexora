import { getCurrentSystemPrompt, getCurrentTools, normalizeContext } from '@earendil-works/pi-ai'
import { Type } from 'typebox'
import { describe, expect, it } from 'vitest'
import { buildBuddyRequestContext } from '../buildBuddyRequestContext'

describe('buildBuddyRequestContext', () => {
  it('includes only active first-party guidelines once and does not promote MCP metadata into instructions', () => {
    const tools = ['lexora_visible', 'lexora_hidden', 'mcp__service__action'].map(name => ({ name, description: name, parameters: Type.Object({}), sourceInfo: { source: 'extension', path: '', origin: 'top-level' as const, scope: 'temporary' as const }, promptGuidelines: [`GUIDELINE_${name}`, `GUIDELINE_${name}`] }))
    const context = buildBuddyRequestContext({ systemPrompt: 'Buddy base prompt', messages: [], tools: [tools[0]!, tools[2]!] }, tools)
    expect(getCurrentSystemPrompt(context.messages).match(/GUIDELINE_lexora_visible/g)).toHaveLength(1)
    expect(getCurrentSystemPrompt(context.messages)).not.toContain('GUIDELINE_lexora_hidden')
    expect(getCurrentSystemPrompt(context.messages)).not.toContain('GUIDELINE_mcp__')
    expect(getCurrentTools(context.messages)).toEqual([tools[0], tools[2]])
  })

  it('preserves transcript history and follows the current tool declarations after removal', () => {
    const tools = ['lexora_old', 'lexora_new'].map(name => ({ name, description: name, parameters: Type.Object({}), sourceInfo: { source: 'extension', path: '', origin: 'top-level' as const, scope: 'temporary' as const }, promptGuidelines: [`GUIDELINE_${name}`] }))
    const input = normalizeContext({ messages: [
      { role: 'system', content: 'Buddy base prompt', toolsAdded: [tools[0]!], timestamp: 0 },
      { role: 'user', content: 'Continue', timestamp: 1 },
      { role: 'system', content: '', sections: { run: 'Current run' }, toolsRemoved: [{ name: tools[0]!.name }], toolsAdded: [tools[1]!], timestamp: 2 },
    ] })
    const original = structuredClone(input.messages)
    const context = buildBuddyRequestContext(input, tools)
    expect(input.messages).toEqual(original)
    expect(context.messages.slice(0, original.length)).toEqual(original)
    expect(getCurrentSystemPrompt(context.messages)).toContain('Current run')
    expect(getCurrentSystemPrompt(context.messages)).toContain('GUIDELINE_lexora_new')
    expect(getCurrentSystemPrompt(context.messages)).not.toContain('GUIDELINE_lexora_old')
    expect(getCurrentTools(context.messages)).toEqual([tools[1]])
  })
})
