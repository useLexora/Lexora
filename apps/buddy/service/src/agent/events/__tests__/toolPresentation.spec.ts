import { Buffer } from 'node:buffer'
import { createBashTool } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from 'vitest'

import {
  createBuddyToolPresentation,
} from '../toolPresentation'

describe('createBuddyToolPresentation', () => {
  it.each([
    ['Command exited with code 1', true, 1, null],
    ['Command exited with code 99\n\nCommand exited with code 2', true, 2, null],
    ['Command exited with code 99\r\n\r\nCommand exited with code 2\r\n', true, 2, null],
    ['Command exited with code 99\n\nCommand timed out after 5 seconds', true, null, null],
    ['Command exited with code 99\n\nCommand aborted', true, null, null],
    ['Example: Command exited with code 99', true, null, null],
    ['Command exited with code 99999999999999999999999', true, null, null],
    ['Command killed by SIGKILL\n\nCommand exited with code 2', true, 2, null],
    ['Command terminated by signal SIGTERM', true, null, 'SIGTERM'],
    ['Command exited with code 99', false, 0, null],
    ['Command killed by SIGKILL', false, 0, null],
    ['Command exited with code 99', undefined, null, null],
    ['Command killed by SIGKILL', undefined, null, null],
  ])('reads only a completed shell failure status from %j', (output, isError, exitCode, signal) => {
    expect(createBuddyToolPresentation({
      arguments: { command: 'fixture' },
      isError,
      result: { content: [{ type: 'text', text: output }] },
      toolName: 'bash',
    })).toMatchObject({ card: 'terminal', exitCode, output, signal })
  })

  it('preserves the actual Pi exit status when stdout contains another exit message', async () => {
    const tool = createBashTool('/workspace', {
      operations: {
        exec: async (_command, _cwd, options) => {
          options.onData(Buffer.from('Command exited with code 99\n'))
          return { exitCode: 2 }
        },
      },
    })
    const result = await tool.execute('tool-1', { command: 'fixture' })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({ exit_code: 2 })
    expect(createBuddyToolPresentation({
      arguments: { command: 'fixture' },
      isError: true,
      result,
      toolName: 'bash',
    })).toMatchObject({ card: 'terminal', exitCode: 2, signal: null })
  })

  it('projects an expired action binding as recoverable', () => {
    const failure = {
      error: {
        code: 'SYSTEM_ACTION_EXPIRED',
        recoverable: true,
        recovery: {
          instruction: 'Retry lexora_system_action so Lexora Buddy can resolve and approve the current target again.',
          toolName: 'lexora_system_action',
        },
      },
    }
    const presentation = createBuddyToolPresentation({
      arguments: {
        action: 'terminate-process',
        reason: 'Finish the disposable expiry target',
        target: {
          kind: 'process',
          pid: 432_101,
        },
      },
      isError: true,
      result: {
        content: [{ type: 'text', text: JSON.stringify(failure) }],
        details: {},
      },
      toolName: 'lexora_system_action',
    })

    expect(presentation).toMatchObject({
      action: 'terminate-process',
      card: 'system',
      output: null,
      status: 'action-expired',
      target: null,
      verified: null,
    })
  })
})
