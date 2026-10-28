import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createTemporaryDirectory } from '@buddy-tests/temporaryDirectories'
import { describe, expect, it } from 'vitest'
import { PermissionEngine } from '../../../../service/src/permissions/PermissionEngine'
import { createSensitivePathMatcher } from '../../../../service/src/permissions/sensitivePaths'
import { createBuddyServiceEnvironment } from '../buddyServiceEnvironment'

describe('service environment and sensitive path policy', () => {
  it.each([
    ['XDG_CONFIG_HOME', 'google-chrome/Default/Cookies'],
    ['XDG_DATA_HOME', 'keyrings/login.keyring'],
  ])('preserves protection after filtering %s', async (key, relativePath) => {
    const root = await createTemporaryDirectory('buddy-env-policy-')
    const relocated = join(root, 'relocated')
    const path = join(relocated, relativePath)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, 'synthetic fixture')
    const environment = createBuddyServiceEnvironment({
      [key]: relocated,
      OPENAI_API_KEY: 'synthetic-secret',
    }, join(root, 'buddy'), 'linux')
    const engine = new PermissionEngine({
      platform: 'linux',
      sensitive: createSensitivePathMatcher({ environment, home: join(root, 'home') }),
    })
    const request = {
      approvalAvailable: true,
      approvalPolicy: 'policy' as const,
      arguments: { path },
      cwd: root,
      grants: [],
      owner: { id: 'fixture', kind: 'conversation' as const },
      profile: 'workspace_write' as const,
      toolName: 'read',
    }
    await expect(engine.decide({ ...request, profile: 'full_access' })).resolves.toEqual({ type: 'allow' })
    expect(environment).not.toHaveProperty('OPENAI_API_KEY')
    await expect(engine.decide(request)).resolves.toMatchObject({ type: 'ask' })
    await expect(engine.decide({ ...request, toolName: 'write' }))
      .resolves
      .toMatchObject({ type: 'deny', code: 'SENSITIVE_PATH' })
  })
})
