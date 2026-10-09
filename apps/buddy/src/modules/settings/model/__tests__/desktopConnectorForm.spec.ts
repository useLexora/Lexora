import type { LocalConnector } from '@buddy-shared/connectors/connectorApi'

import { describe, expect, it } from 'vitest'

import { createConnectorSavePlan } from '../desktopConnectorForm'

describe('createConnectorSavePlan', () => {
  it('persists a new stdio connector disabled with named environment credentials', () => {
    const plan = createConnectorSavePlan({
      args: 'server.mjs\n--stdio',
      bearerToken: '',
      command: 'node',
      env: 'GITHUB_PERSONAL_ACCESS_TOKEN=redacted\nCUSTOM_TOKEN= value=with=equals ',
      headers: '',
      id: 'github',
      name: 'GitHub',
      transport: 'stdio',
      url: '',
    })

    expect(plan).toEqual({
      config: {
        args: ['server.mjs', '--stdio'],
        command: 'node',
        cwd: null,
        enabled: false,
        id: 'github',
        name: 'GitHub',
        toolExposure: 'deferred',
        transport: 'stdio',
      },
      credential: {
        mode: 'replace',
        value: {
          env: {
            CUSTOM_TOKEN: ' value=with=equals ',
            GITHUB_PERSONAL_ACCESS_TOKEN: 'redacted',
          },
          type: 'stdio',
        },
      },
    })
  })

  it('preserves enabled only while the trusted stdio execution target is unchanged', () => {
    const connector: LocalConnector = {
      args: ['server.mjs', '--stdio', '/workspace with spaces'],
      command: 'node',
      runtime: { authorization: null, status: 'ready', errorCode: null, toolCount: 0, updatedAt: null },
      credentialConfigured: true,
      toolNamespace: 'fixture',
      toolExposure: 'deferred',
      cwd: '/workspace',
      enabled: true,
      id: 'local',
      name: 'Local',
      transport: 'stdio',
      executionConfirmed: true,
    }
    const base = {
      args: 'server.mjs --stdio "/workspace with spaces"',
      bearerToken: '',
      command: 'node',
      env: '',
      headers: '',
      id: 'local',
      name: 'Local',
      transport: 'stdio' as const,
      url: '',
    }

    const unchanged = createConnectorSavePlan(base, connector).config
    expect(unchanged.transport === 'stdio' && unchanged.args).toEqual(connector.args)
    expect(unchanged.enabled).toBe(true)
    expect(unchanged.transport === 'stdio' && unchanged.cwd).toBe('/workspace')
    expect(createConnectorSavePlan({ ...base, command: 'bun' }, connector).config.enabled).toBe(false)
  })

  it('keeps HTTP bearer and header credentials as separate protocol fields', () => {
    const plan = createConnectorSavePlan({
      args: '',
      bearerToken: 'redacted-bearer',
      command: '',
      env: '',
      headers: 'X-API-Key=redacted-key\nX-Tenant=personal',
      id: 'remote',
      name: 'Remote',
      transport: 'streamable-http',
      url: 'https://mcp.example.com',
    })

    expect(plan.credential).toEqual({
      mode: 'replace',
      value: {
        bearerToken: 'redacted-bearer',
        headers: {
          'X-API-Key': 'redacted-key',
          'X-Tenant': 'personal',
        },
        type: 'http',
      },
    })
  })

  it('preserves existing HTTP settings without transferring credentials to a new target', () => {
    const connector: LocalConnector = {
      runtime: { authorization: null, status: 'ready', errorCode: null, toolCount: 0, updatedAt: null },
      credentialConfigured: true,
      toolNamespace: 'fixture',
      toolExposure: 'hidden',
      enabled: true,
      id: 'remote',
      name: 'Remote',
      transport: 'streamable-http',
      executionConfirmed: false,
      url: 'https://first.example.com/mcp',
    }
    const form = {
      args: '',
      bearerToken: '',
      command: '',
      env: '',
      headers: '',
      id: 'remote',
      name: 'Remote',
      transport: 'streamable-http' as const,
      url: connector.url,
    }

    expect(createConnectorSavePlan(form, connector)).toMatchObject({
      config: { toolNamespace: 'fixture', toolExposure: 'hidden', enabled: true },
      credential: { mode: 'keep' },
    })
    expect(createConnectorSavePlan({
      ...form,
      url: 'https://second.example.com/mcp',
    }, connector)).toMatchObject({ config: { enabled: false }, credential: { mode: 'clear' } })
  })

  it('rejects credential names that the runtime protocol cannot accept', () => {
    expect(() => createConnectorSavePlan({
      args: '',
      bearerToken: '',
      command: '',
      env: '',
      headers: 'Invalid Header=value',
      id: 'remote',
      name: 'Remote',
      transport: 'streamable-http',
      url: 'https://mcp.example.com',
    })).toThrow('INVALID_KEY_VALUE_ENTRY')
  })
})
