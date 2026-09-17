import { describe, expect, it } from 'vitest'
import { resolveBuddyPlatform } from '../../../shared/platform'
import { createChildProcessEnvironment } from '../childProcessEnvironment'

describe('child process environment', () => {
  it.each(['linux', 'win32', 'darwin'])('allows ambient platform inputs and only explicitly provided secrets on %s', (platform) => {
    expect(createChildProcessEnvironment({
      platform: resolveBuddyPlatform(platform),
      source: { LANG: 'zh_CN.UTF-8', OPENAI_API_KEY: 'synthetic-ambient', LEXORA_BUDDY_HOME: '/fixture/buddy' },
      additions: { MCP_TOKEN: 'synthetic-connector', OPENAI_API_KEY: 'synthetic-explicit' },
    })).toEqual({ LANG: 'zh_CN.UTF-8', MCP_TOKEN: 'synthetic-connector', OPENAI_API_KEY: 'synthetic-explicit' })
  })

  it('merges Windows overrides into one key independent of spelling', () => {
    expect(createChildProcessEnvironment({
      platform: resolveBuddyPlatform('win32'),
      source: { PATH: 'C:\\old', SystemRoot: 'C:\\Windows', No_Proxy: 'localhost' },
      additions: { Path: 'D:\\中文 路径', systemroot: 'D:\\Windows', token: 'first', TOKEN: 'last' },
    })).toEqual({ PATH: 'D:\\中文 路径', SYSTEMROOT: 'D:\\Windows', NO_PROXY: 'localhost', TOKEN: 'last' })
  })

  it('preserves distinct case-sensitive Linux inputs and excludes undefined and inherited shell functions', () => {
    expect(createChildProcessEnvironment({
      platform: resolveBuddyPlatform('linux'),
      source: { PATH: '/usr/bin', LANG: '() { synthetic; }', TZ: undefined, NO_PROXY: 'upper', no_proxy: 'lower' },
      additions: { Path: '/fixture/bin', TOKEN: undefined },
    })).toEqual({ PATH: '/usr/bin', Path: '/fixture/bin', NO_PROXY: 'upper', no_proxy: 'lower' })
  })
})
