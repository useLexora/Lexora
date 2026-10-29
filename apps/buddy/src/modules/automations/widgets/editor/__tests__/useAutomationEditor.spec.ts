import type { LocalRuntimeModelOption } from '@buddy-shared/providers/providerApi'
import type { AutomationEditorProps } from '../typing'
import { automationTimingSchema } from '@buddy-shared/automation'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, reactive } from 'vue'
import { useAutomationEditor } from '../useAutomationEditor'

const model: LocalRuntimeModelOption = {
  available: true,
  type: 'chat',
  sourceType: 'chat',
  typeOverride: null,
  catalogMatch: 'not_applicable',
  catalog: { source: null, selection: null, candidates: [] },
  metadataKnown: true,
  capabilityOverrides: null,
  fileInputMimeTypes: [],
  sourceCapabilities: { image: false, reasoningOptions: ['off', 'low', 'high'] },
  api: 'openai-completions',
  capabilities: ['text'],
  contextWindow: 4096,
  displayName: 'Example model',
  enabled: true,
  hasParameterOverride: false,
  lastSeenAt: null,
  maxTokens: 1024,
  modelId: 'example',
  overrideContextWindow: null,
  overrideMaxTokens: null,
  providerId: 'provider',
  reasoningOptions: ['off', 'low', 'high'],
  serviceTiers: [],
  source: 'builtin',
  sourceContextWindow: 4096,
  sourceMaxTokens: 1024,
  sourceParametersUpdated: false,
}

describe('automation editor input ownership', () => {
  afterEach(() => vi.useRealTimers())

  it('preserves input across catalog changes while blocking unsupported pinned configuration', async () => {
    vi.useFakeTimers()
    const scope = effectScope()
    const props = reactive<AutomationEditorProps>({
      automation: null,
      busy: false,
      error: null,
      language: 'zh-CN',
      loading: false,
      mode: 'create',
      models: [model],
      providers: [],
      spaces: [],
      preview: async ({ timing }) => ({
        frequency: { cadence: 'daily', kind: 'calendar', localTime: '09:00', timezone: 'Asia/Shanghai' },
        nextRunAt: '2026-09-09T01:00:00.000Z',
        normalizedTiming: automationTimingSchema.parse(timing),
        samples: ['2026-09-09T01:00:00.000Z'],
        valid: true,
      }),
    })
    const editor = scope.run(() => useAutomationEditor(props))!
    try {
      editor.form.name = 'Preserve this name'
      editor.form.prompt = 'Preserve this prompt'
      editor.updatePinnedModel('provider:example')
      editor.form.reasoning = 'high'
      await vi.advanceTimersByTimeAsync(180)
      expect(editor.canSave.value).toBe(true)

      props.models = [{ ...model, reasoningOptions: ['off', 'low'] }]
      props.language = 'en-US'
      expect(editor.form.reasoning).toBe('high')
      expect(editor.modelIssue.value).toBe('reasoningUnavailable')
      expect(editor.draftForSave()).toBeNull()
      editor.form.reasoning = 'low'
      expect(editor.draftForSave()?.model).toEqual({ mode: 'pinned', modelId: 'example', providerId: 'provider', reasoning: 'low' })

      props.models = []
      expect(editor.modelIssue.value).toBe('modelUnavailable')
      expect(editor.draftForSave()).toBeNull()
      props.models = [model]
      expect(editor.draftForSave()).toMatchObject({ name: 'Preserve this name', prompt: 'Preserve this prompt' })
      props.busy = true
      expect(editor.draftForSave()).toBeNull()
    }
    finally {
      scope.stop()
    }
  })
})
