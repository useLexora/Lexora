import type { ConnectorCredential } from '../../../../../shared/connectors/connectorCredentials'
import type { ConnectorSecretStore } from '../McpCredentialChanges'
import type { McpConnectorDetails } from '../mcpEvents'
import { describe, expect, it } from 'vitest'
import { McpCredentialChanges } from '../McpCredentialChanges'

function fixture() {
  const original: ConnectorCredential = { type: 'http', bearerToken: 'fixture-original' }
  let secret: ConnectorCredential | null = original
  const events: McpConnectorDetails[] = []
  const secrets: ConnectorSecretStore = {
    read: async () => secret,
    write: async (_, value) => { secret = value },
    delete: async () => { secret = null },
  }
  const changes = new McpCredentialChanges(secrets, (_, event) => events.push(event))
  return { original, secrets, changes, events, get secret() {
    return secret
  } }
}

describe('mCP credential compensation', () => {
  it('restores the original secret when the target changes during a write', async () => {
    const f = fixture()
    let target = 'original'
    const write = f.secrets.write
    f.secrets.write = async (ref, value) => {
      await write(ref, value)
      target = 'changed'
    }
    let configuration = 'original'
    await expect(f.changes.commit({
      connectorId: 'connector',
      replacement: { ref: 'credential', value: { type: 'http', bearerToken: 'fixture-new' } },
      validate: () => {
        if (target !== 'original')
          throw new Error('target changed')
      },
      commit: () => { configuration = 'changed' },
    })).rejects.toThrow('target changed')
    expect(configuration).toBe('original')
    expect(f.secret).toEqual(f.original)
    expect(f.events).toEqual([
      { type: 'credential', status: 'written', presence: 'present' },
      { type: 'credential', status: 'restored', presence: 'present' },
    ])
  })

  it('restores a deleted secret when the configuration was not removed', async () => {
    const f = fixture()
    const removed = await f.changes.commit({
      connectorId: 'connector',
      replacement: { ref: 'credential', value: null },
      commit: () => false,
      committed: value => value,
    })
    expect(removed).toBe(false)
    expect(f.secret).toEqual(f.original)
    expect(f.events.at(-1)).toEqual({ type: 'credential', status: 'restored', presence: 'present' })
  })

  it('reports unknown secret presence when compensation fails', async () => {
    const f = fixture()
    f.secrets.write = async () => {
      throw new Error('secret store unavailable')
    }
    await expect(f.changes.commit({
      connectorId: 'connector',
      replacement: { ref: 'credential', value: null },
      commit: () => {
        throw new Error('configuration unavailable')
      },
    })).rejects.toThrow('secret store unavailable')
    expect(f.events).toEqual([
      { type: 'credential', status: 'deleted', presence: 'absent' },
      { type: 'credential', status: 'restore-failed', presence: 'unknown' },
    ])
    expect(JSON.stringify(f.events)).not.toContain('fixture-original')
  })
})
