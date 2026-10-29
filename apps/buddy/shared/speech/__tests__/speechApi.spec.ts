import { join } from 'node:path'
import { createTemporaryDirectory } from '@buddy-tests/temporaryDirectories'
import { describe, expect, it } from 'vitest'
import { LexoraConfigStore } from '../../../electron/main/config/LexoraConfigStore'
import { lexoraConfigPatchSchema } from '../../../electron/shared/desktopApiSchemas'
import { speechOutput, speechPreferencesSchema, speechSelection, speechStartSchema } from '../speechApi'

describe('speech preferences', () => {
  it('defaults to system speech and preserves existing model selections', () => {
    expect(speechOutput(speechPreferencesSchema.parse({}))).toBe('system')
    const migrated = speechPreferencesSchema.parse({ synthesize: { extensionId: 'example.voice', capability: 'speak' } })
    expect(migrated.synthesize).toEqual({ id: 'extension:example.voice:speak' })
    expect(speechOutput(migrated)).toBe('model')
    expect(speechOutput({ ...migrated, output: 'system' })).toBe('system')
  })
  it('migrates retired dedicated sources while retaining remembered model choices', () => {
    const migrated = speechPreferencesSchema.parse({
      input: 'service',
      output: 'service',
      transcribe: { id: 'direct:old-input' },
      synthesize: { model: { id: 'service:model-output' }, service: { id: 'direct:old-output' } },
    })
    expect(migrated).toMatchObject({ transcribe: null, synthesize: { id: 'service:model-output' }, output: 'model' })
    expect(migrated).not.toHaveProperty('input')
    expect(speechPreferencesSchema.parse({ output: 'service', synthesize: { id: 'direct:old-output' } })).toMatchObject({ synthesize: null, output: 'system' })
  })
  it('bounds model identities and output preferences', () => {
    const speech = { transcribe: { id: 'service:transcription' }, output: 'system', systemRate: 1.2, systemVoice: 'voice:en' }
    expect(lexoraConfigPatchSchema.parse({ desktop: { speech } }).desktop?.speech).toEqual(speech)
    for (const invalid of [{ systemRate: 0 }, { systemRate: 3 }, { systemVoice: 'x'.repeat(513) }, { transcribe: { id: '' } }])
      expect(speechPreferencesSchema.safeParse(invalid).success).toBe(false)
  })
  it('requires bounded text only for synthesis and pins the selected model revision', () => {
    const base = { id: 'c8f2b671-aed2-443d-9d6c-16b3f2254eb3', provider: { id: 'voice', revision: 'v1' } }
    expect(speechStartSchema.safeParse({ ...base, kind: 'speech.transcribe' }).success).toBe(true)
    expect(speechStartSchema.safeParse({ ...base, kind: 'speech.synthesize', text: 'Hello' }).success).toBe(true)
    for (const value of [{ kind: 'speech.synthesize' }, { kind: 'speech.transcribe', text: 'wrong' }, { kind: 'speech.synthesize', text: 'x'.repeat(16001) }])
      expect(speechStartSchema.safeParse({ ...base, ...value }).success).toBe(false)
  })
})

it('retains the output model when switching to system speech and restarting', async () => {
  const configPath = join(await createTemporaryDirectory('lexora-speech-config-'), 'config.toml')
  const store = new LexoraConfigStore({ configPath })
  await store.update({ desktop: { speech: { output: 'model', synthesize: { id: 'service:model-a' } } } })
  await store.update({ desktop: { speech: { output: 'system' } } })
  const restored = (await new LexoraConfigStore({ configPath }).read()).desktop.speech!
  expect(speechSelection({ ...restored, output: 'model' }, 'speech.synthesize')?.id).toBe('service:model-a')
})
