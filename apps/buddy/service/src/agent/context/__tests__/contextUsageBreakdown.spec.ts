import type { Context } from '@earendil-works/pi-ai'
import { getCurrentSystemPrompt, getCurrentTools, normalizeContext } from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'
import {
  createContextUsageBreakdown,
  createEstimatedContextUsage,
} from '../contextUsageBreakdown'

describe('createContextUsageBreakdown', () => {
  it('attributes the real request sources and keeps the provider total exact', async () => {
    const context: Context = {
      messages: [{
        content: '<skill name="review" location="/skills/review/SKILL.md">Follow the review contract.</skill>\n\nReview this change.',
        role: 'user',
        timestamp: Date.now(),
      }],
      systemPrompt: [
        'You are Lexora Buddy.',
        '',
        'The following skills provide specialized instructions for specific tasks.',
        '<available_skills>',
        '<skill>review</skill>',
        '</available_skills>',
        'Current working directory: /workspace',
      ].join('\n'),
      tools: [
        { description: 'Read files', name: 'read', parameters: { type: 'object' } as never },
        { description: 'Search issues', name: 'mcp__github__search', parameters: { type: 'object' } as never },
      ],
    }

    const usage = createContextUsageBreakdown(context, 1_000)

    expect(usage.systemPromptTokens).toBeGreaterThan(0)
    expect(usage.toolTokens).toBeGreaterThan(0)
    expect(usage.skillTokens).toBeGreaterThan(0)
    expect(usage.mcpTokens).toBeGreaterThan(0)
    expect(usage.messageTokens).toBeGreaterThan(0)
    expect(Object.values(usage).reduce((total, value) => total + value, 0)).toBe(1_000)
  })

  it('scales attributed sources without exceeding a small provider total', async () => {
    const usage = createContextUsageBreakdown({
      messages: [],
      systemPrompt: 'x'.repeat(4_000),
      tools: [{ description: 'y'.repeat(2_000), name: 'read', parameters: { type: 'object' } as never }],
    }, 100)

    expect(usage.messageTokens).toBe(0)
    expect(Object.values(usage).reduce((total, value) => total + value, 0)).toBe(100)
  })

  it('attributes the current system state once after prompt and tool changes', () => {
    const context = normalizeContext({ messages: [
      { role: 'system', content: 'Original prompt', toolsAdded: [{ name: 'read', description: 'Read', parameters: { type: 'object' } as never }], timestamp: 0 },
      { role: 'user', content: 'Continue', timestamp: 1 },
      { role: 'system', content: 'Updated prompt', toolsRemoved: [{ name: 'read' }], toolsAdded: [{ name: 'mcp__calendar__list', description: 'List events', parameters: { type: 'object' } as never }], timestamp: 2 },
    ] })
    const current: Context = {
      systemPrompt: getCurrentSystemPrompt(context.messages),
      tools: getCurrentTools(context.messages),
      messages: context.messages.filter(message => message.role !== 'system'),
    }
    expect(createEstimatedContextUsage(context)).toEqual(createEstimatedContextUsage(current))
    expect(createContextUsageBreakdown(context, 1_000)).toEqual(createContextUsageBreakdown(current, 1_000))
  })
})
