import type { LocalSpace } from '@buddy-shared/spaces/spaceApi'
import { describe, expect, it } from 'vitest'
import { artifactFileTarget } from '../artifactFileTarget'

function space(root = '/workspace'): LocalSpace {
  return {
    id: 'space',
    revokedAt: null,
    primaryDirectory: { id: 'primary', revision: 4, root, canonicalRoot: root, revokedAt: null },
    additionalDirectories: [],
  } as unknown as LocalSpace
}

describe('artifact file tree targets', () => {
  it('keeps literal filename characters and supports a directory at the root', () => {
    expect(artifactFileTarget(space(), '/workspace/report #1?draft%20.txt')).toEqual({
      spaceId: 'space',
      directoryId: 'primary',
      revision: 4,
      path: 'report #1?draft%20.txt',
    })
    expect(artifactFileTarget(space(), '/workspace')?.path).toBe('')
    expect(artifactFileTarget(space('/'), '/report.txt')?.path).toBe('report.txt')
  })

  it('uses the most specific binding with Windows case-insensitive roots', () => {
    const target = space('C:\\Work')
    const nested = { ...target.primaryDirectory!, id: 'nested', root: 'C:\\Work\\Nested', canonicalRoot: 'C:\\Work\\Nested', revision: 8 }
    expect(artifactFileTarget({ ...target, additionalDirectories: [nested] }, 'c:\\work\\NESTED\\Report.txt')).toEqual({
      spaceId: 'space',
      directoryId: 'nested',
      revision: 8,
      path: 'Report.txt',
    })
    expect(artifactFileTarget(space('\\\\server\\share'), '\\\\SERVER\\SHARE\\Report.txt')?.path).toBe('Report.txt')
  })

  it('does not turn unbound, revoked, sibling or traversal paths into accessible targets', () => {
    for (const path of ['/workspace-other/file.txt', '/workspace/../file.txt', '/workspace/./file.txt', '/Workspace/file.txt', '/workspace/file\0.txt'])
      expect(artifactFileTarget(space(), path)).toBeNull()
    expect(artifactFileTarget(null, '/workspace/file.txt')).toBeNull()
    expect(artifactFileTarget({ ...space(), revokedAt: 'revoked' }, '/workspace/file.txt')).toBeNull()
    expect(artifactFileTarget({ ...space(), primaryDirectory: { ...space().primaryDirectory!, revokedAt: 'revoked' } }, '/workspace/file.txt')).toBeNull()
  })
})
