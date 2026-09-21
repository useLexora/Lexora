import { describe, expect, it } from 'vitest'

import { isExecutionProfileWithin } from '../../permissions/executionProfile'
import {
  BUDDY_CHAT_COMMANDS,
  isBuddyReviewCommand,
  isBuddyRunChatCommand,
  isRetiredBuddyPromptCommand,
  parseBuddyChatCommand,
} from '../buddyChatCommands'

describe('buddyChatCommands', () => {
  it('parses only registered commands at the start of the message', () => {
    expect(parseBuddyChatCommand('/compact focus on unresolved decisions')).toEqual({
      arguments: 'focus on unresolved decisions',
      name: 'compact',
    })
    expect(parseBuddyChatCommand('  /compact\nthen continue')).toEqual({
      arguments: 'then continue',
      name: 'compact',
    })
    expect(parseBuddyChatCommand('/skills')).toEqual({ arguments: '', name: 'skills' })
    expect(parseBuddyChatCommand('/review 只看权限边界')).toEqual({ arguments: '只看权限边界', name: 'review' })
    expect(parseBuddyChatCommand('/plan')).toBeNull()
    expect(parseBuddyChatCommand('please /compact')).toBeNull()
    expect(parseBuddyChatCommand('/unknown')).toBeNull()
  })

  it('marks run commands so only the service decides how a run is executed', () => {
    expect(BUDDY_CHAT_COMMANDS.map(command => command.name)).toEqual(['compact', 'review', 'skills', 'status'])
    expect(isBuddyRunChatCommand('compact')).toBe(true)
    expect(isBuddyRunChatCommand('skills')).toBe(false)
    expect(isBuddyRunChatCommand('review')).toBe(false)
    expect(isBuddyRunChatCommand('status')).toBe(false)
    expect(isBuddyRunChatCommand('unknown')).toBe(false)
  })

  it('scopes a single run profile to the conversation profile width', () => {
    expect(isExecutionProfileWithin('read_only', 'workspace_write')).toBe(true)
    expect(isExecutionProfileWithin('read_only', 'read_only')).toBe(true)
    expect(isExecutionProfileWithin('workspace_write', 'read_only')).toBe(false)
    expect(isExecutionProfileWithin('full_access', 'workspace_write')).toBe(false)
  })

  it('recognizes the read-only review command', () => {
    expect(isBuddyReviewCommand('/review')).toBe(true)
    expect(isBuddyReviewCommand('/review 只看权限边界')).toBe(true)
    expect(isBuddyReviewCommand('/reviews')).toBe(false)
    expect(isBuddyReviewCommand('/compact')).toBe(false)
  })

  it('keeps local actions available while retiring their former prompt directives', () => {
    expect(parseBuddyChatCommand('/plan')).toBeNull()
    expect(parseBuddyChatCommand('/status')).toEqual({ arguments: '', name: 'status' })
    expect(parseBuddyChatCommand('/skills')?.name).toBe('skills')
    for (const value of ['/plan', '  /plan\n继续', '/status', '/skills'])
      expect(isRetiredBuddyPromptCommand(value)).toBe(true)
    for (const value of ['/plans', 'plan', '/compact', '/review', '/unknown'])
      expect(isRetiredBuddyPromptCommand(value)).toBe(false)
  })
})
