import { expect, it } from 'vitest'
import { buddySettingsSchema, DEFAULT_BUDDY_SETTINGS } from '../buddySettings'

it('validates capability identity, required skill scope and finite concurrency', () => {
  const toolId = JSON.stringify(['mcp', `connection-${'x'.repeat(1024)}`, 'lookup'])
  expect(buddySettingsSchema.parse({ ...DEFAULT_BUDDY_SETTINGS, tools: { mode: 'selected', ids: [toolId] }, npcConcurrency: { mode: 'unlimited' } }).tools).toEqual({ mode: 'selected', ids: [toolId] })
  for (const limit of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])
    expect(buddySettingsSchema.safeParse({ ...DEFAULT_BUDDY_SETTINGS, npcConcurrency: { mode: 'limited', limit } }).success).toBe(false)
  for (const id of ['tool-name', '["mcp","connection"]', '["mcp","","lookup"]'])
    expect(buddySettingsSchema.safeParse({ ...DEFAULT_BUDDY_SETTINGS, tools: { mode: 'selected', ids: [id] } }).success).toBe(false)
  expect(buddySettingsSchema.safeParse({ ...DEFAULT_BUDDY_SETTINGS, skills: { mode: 'none' }, requiredSkills: ['skill'] }).success).toBe(false)
  expect(buddySettingsSchema.safeParse({ ...DEFAULT_BUDDY_SETTINGS, skills: { mode: 'selected', ids: ['skill-a'] }, requiredSkills: ['skill-b'] }).success).toBe(false)
  expect(buddySettingsSchema.parse({ ...DEFAULT_BUDDY_SETTINGS, skills: { mode: 'selected', ids: ['skill-a'] }, requiredSkills: ['skill-a'] }).requiredSkills).toEqual(['skill-a'])
})
