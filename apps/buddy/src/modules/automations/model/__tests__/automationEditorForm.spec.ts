import type { AutomationDefinitionDraft, AutomationSchedule } from '@buddy-shared/automation'
import type { AutomationEditorForm } from '../typing'
import { Temporal } from '@buddy-shared/automation/temporal'
import { BUDDY_EXECUTION_PROFILES } from '@buddy-shared/permissions/executionProfile'
import { describe, expect, it } from 'vitest'
import {
  automationEditorFormFromDefinition,
  buildAutomationDraft,
  buildAutomationTiming,
  createAutomationEditorForm,
} from '../automationEditorForm'

const currentTime = Temporal.ZonedDateTime.from('2026-09-08T12:34:56+08:00[Asia/Shanghai]')
const overlappingInstant = '2026-11-01T06:30:47.123Z'
const schedules: AutomationSchedule[] = [
  { cadence: 'daily', kind: 'calendar', localTime: '09:15' },
  { cadence: 'weekly', kind: 'calendar', localTime: '09:15', weekdays: [1, 3, 7] },
  { cadence: 'monthly', dayOfMonth: 'last', kind: 'calendar', localTime: '09:15' },
  { cadence: 'yearly', day: 29, kind: 'calendar', localTime: '09:15', month: 2 },
  { anchorAt: overlappingInstant, every: 1.5, kind: 'interval', unit: 'hour' },
  { anchorAt: overlappingInstant, every: 3, kind: 'interval', unit: 'day' },
  { kind: 'once', runAt: overlappingInstant },
]

describe('automation editor form', () => {
  it('preserves a fixed actor and restores application-default routing when cleared', () => {
    const definition = { ...draft(schedules[0]!), actorId: 'actor-fixture' }
    const form = automationEditorFormFromDefinition(definition, currentTime)
    expect(buildAutomationDraft(form, definition.timing)?.actorId).toBe('actor-fixture')
    form.actorId = null
    expect(buildAutomationDraft(form, definition.timing)?.actorId).toBeNull()
    expect(automationEditorFormFromDefinition({ ...definition, actorId: undefined }, currentTime).actorId).toBeNull()
  })

  it('creates local defaults at the next whole hour across a date boundary', () => {
    const form = createAutomationEditorForm(
      Temporal.ZonedDateTime.from('2026-12-31T23:45:37.123+08:00[Asia/Shanghai]'),
    )

    expect(form).toMatchObject({
      anchorLocal: '2026-12-31 23:45',
      cadence: 'daily',
      day: 1,
      dayOfMonth: 1,
      executionProfile: 'workspace_write',
      localTime: '00:00',
      modelMode: 'default',
      month: 1,
      onceLocal: '2027-01-01 00:00',
      pinnedModelKey: null,
      spaceId: null,
      timezone: 'Asia/Shanghai',
      weekdays: [5],
    })
  })

  it.each(schedules)('round-trips the persisted timezone and schedule $kind', (schedule) => {
    const definition = draft(schedule)
    const form = automationEditorFormFromDefinition(definition, currentTime)

    expect(form.timezone).toBe('America/New_York')
    expect(buildAutomationDraft(form, definition.timing)).toEqual(definition)
    expect(buildAutomationTiming(form, definition.timing)).toEqual(definition.timing)
  })

  it.each(BUDDY_EXECUTION_PROFILES)('retains %s permission, pinned model and space when renamed', (executionProfile) => {
    const definition = {
      ...draft(schedules[1]!),
      executionProfile,
    }
    const form = automationEditorFormFromDefinition(definition, currentTime)
    form.name = 'Renamed automation'

    expect(buildAutomationDraft(form, definition.timing)).toEqual({
      ...definition,
      name: 'Renamed automation',
    })
    expect(form.pinnedModelKey).toBe('provider-1:claude:latest')
    expect(form.reasoning).toBe('high')
  })

  it('returns to the default model without persisting stale pinned selections', () => {
    const definition = draft(schedules[0]!)
    const form = automationEditorFormFromDefinition(definition, currentTime)
    form.modelMode = 'default'

    expect(buildAutomationDraft(form, definition.timing)?.model).toEqual({ mode: 'default' })
    const defaultForm = automationEditorFormFromDefinition({
      ...definition,
      model: { mode: 'default' },
      spaceId: null,
    }, currentTime)
    expect(defaultForm).toMatchObject({
      modelMode: 'default',
      pinnedModelKey: null,
      reasoning: null,
      spaceId: null,
    })
  })

  it('keeps schedule arrays independent from the saved definition', () => {
    const definition = draft(schedules[1]!)
    const form = automationEditorFormFromDefinition(definition, currentTime)
    form.weekdays.push(5)

    expect(definition.timing.schedule).toMatchObject({ weekdays: [1, 3, 7] })
    expect(buildAutomationTiming(form)?.schedule).toMatchObject({ weekdays: [1, 3, 7, 5] })
  })

  it('preserves an unchanged once instant in the later DST overlap, including sub-minute precision', () => {
    const definition = draft({ kind: 'once', runAt: overlappingInstant })
    const form = automationEditorFormFromDefinition(definition, currentTime)

    expect(form.onceLocal).toBe('2026-11-01 01:30')
    expect(buildAutomationTiming(form, definition.timing)?.schedule).toEqual({
      kind: 'once',
      runAt: overlappingInstant,
    })

    form.onceLocal = '2026-11-01 02:15'
    expect(buildAutomationTiming(form, definition.timing)?.schedule).toEqual({
      kind: 'once',
      runAt: '2026-11-01T07:15:00.000Z',
    })
  })

  it('keeps the interval anchor instant when only its cadence changes', () => {
    const definition = draft({ anchorAt: overlappingInstant, every: 1, kind: 'interval', unit: 'hour' })
    const form = automationEditorFormFromDefinition(definition, currentTime)
    form.every = 2

    expect(form.anchorLocal).toBe('2026-11-01 01:30')
    expect(buildAutomationTiming(form, definition.timing)?.schedule).toEqual({
      anchorAt: overlappingInstant,
      every: 2,
      kind: 'interval',
      unit: 'hour',
    })
  })

  it('uses Temporal wall-time disambiguation when the interval anchor is edited into a DST gap', () => {
    const definition = draft({ anchorAt: overlappingInstant, every: 1, kind: 'interval', unit: 'hour' })
    const form = automationEditorFormFromDefinition(definition, currentTime)
    form.anchorLocal = '2026-03-08 02:30'

    expect(buildAutomationTiming(form, definition.timing)?.schedule).toEqual({
      anchorAt: '2026-03-08T07:30:00.000Z',
      every: 1,
      kind: 'interval',
      unit: 'hour',
    })
  })

  it('clears recurring date bounds when switching to once', () => {
    const form = automationEditorFormFromDefinition(draft(schedules[0]!), currentTime)
    form.frequencyMode = 'once'
    form.onceLocal = '2026-09-09 09:15'

    expect(buildAutomationTiming(form)).toEqual({
      activeFrom: null,
      activeUntil: null,
      schedule: { kind: 'once', runAt: '2026-09-09T13:15:00.000Z' },
      timezone: 'America/New_York',
    })
  })

  it.each<Partial<AutomationEditorForm>>([
    { localTime: null },
    { cadence: 'weekly', weekdays: [] },
    { cadence: 'yearly', day: 30, month: 2 },
    { every: 1.5, frequencyMode: 'interval', intervalUnit: 'day' },
    { frequencyMode: 'once', onceLocal: null },
    { activeFrom: '2026-09-10', activeUntil: '2026-09-09' },
    { timezone: 'Invalid/Timezone' },
  ])('rejects invalid schedule input %j', (patch) => {
    const form = automationEditorFormFromDefinition(draft(schedules[0]!), currentTime)

    expect(buildAutomationTiming({ ...form, ...patch })).toBeNull()
  })

  it.each([null, '', 'provider', 'provider:'])('rejects an incomplete pinned model key %s', (pinnedModelKey) => {
    const form = automationEditorFormFromDefinition(draft(schedules[0]!), currentTime)

    expect(buildAutomationDraft({ ...form, pinnedModelKey })).toBeNull()
  })
})

function draft(schedule: AutomationSchedule): AutomationDefinitionDraft {
  return {
    actorId: null,
    executionProfile: 'workspace_write',
    model: {
      mode: 'pinned',
      modelId: 'claude:latest',
      providerId: 'provider-1',
      reasoning: 'high',
    },
    name: 'Daily summary',
    prompt: 'Summarize the authorized workspace.',
    spaceId: 'space-1',
    timing: {
      activeFrom: schedule.kind === 'once' ? null : '2026-09-08',
      activeUntil: schedule.kind === 'once' ? null : '2027-09-08',
      schedule,
      timezone: 'America/New_York',
    },
  }
}
