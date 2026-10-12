import type { AutomationDefinitionDraft, AutomationTiming } from '@buddy-shared/automation'
import type { LocalAutomation } from '@buddy-shared/automation/automationApi'

import type { AutomationEditorForm, AutomationScheduleForm } from './typing'
import { automationDefinitionDraftSchema, automationTimingSchema } from '@buddy-shared/automation'
import { Temporal } from '@buddy-shared/automation/temporal'

export function buildAutomationDraft(
  value: AutomationEditorForm,
  previousTiming?: LocalAutomation['timing'],
): AutomationDefinitionDraft | null {
  const timing = buildAutomationTiming(value, previousTiming)
  const model = value.modelMode === 'default'
    ? { mode: 'default' as const }
    : parsePinnedModel(value)
  if (!timing || !model)
    return null
  const result = automationDefinitionDraftSchema.safeParse({
    actorId: value.actorId,
    executionProfile: value.executionProfile,
    model,
    name: value.name,
    spaceId: value.spaceId,
    prompt: value.prompt,
    timing,
  })
  return result.success ? result.data : null
}

export function buildAutomationTiming(
  value: AutomationScheduleForm,
  previousTiming?: LocalAutomation['timing'],
): AutomationTiming | null {
  try {
    const common = {
      activeFrom: value.frequencyMode === 'once' ? null : value.activeFrom,
      activeUntil: value.frequencyMode === 'once' ? null : value.activeUntil,
      timezone: value.timezone,
    }
    let schedule: AutomationTiming['schedule']
    if (value.frequencyMode === 'once') {
      if (!value.onceLocal)
        return null
      schedule = {
        kind: 'once',
        runAt: wallTimeToInstant(
          value.onceLocal,
          value.timezone,
          previousTiming?.schedule.kind === 'once' ? previousTiming.schedule.runAt : undefined,
        ),
      }
    }
    else if (value.frequencyMode === 'interval') {
      if (!value.anchorLocal)
        return null
      schedule = {
        anchorAt: wallTimeToInstant(
          value.anchorLocal,
          value.timezone,
          previousTiming?.schedule.kind === 'interval' ? previousTiming.schedule.anchorAt : undefined,
        ),
        every: value.every,
        kind: 'interval',
        unit: value.intervalUnit,
      }
    }
    else {
      if (!value.localTime)
        return null
      if (value.cadence === 'daily') {
        schedule = { cadence: 'daily', kind: 'calendar', localTime: value.localTime }
      }
      else if (value.cadence === 'weekly') {
        schedule = {
          cadence: 'weekly',
          kind: 'calendar',
          localTime: value.localTime,
          weekdays: value.weekdays,
        }
      }
      else if (value.cadence === 'monthly') {
        schedule = {
          cadence: 'monthly',
          dayOfMonth: value.dayOfMonth,
          kind: 'calendar',
          localTime: value.localTime,
        }
      }
      else {
        schedule = {
          cadence: 'yearly',
          day: value.day,
          kind: 'calendar',
          localTime: value.localTime,
          month: value.month,
        }
      }
    }
    const result = automationTimingSchema.safeParse({ ...common, schedule })
    return result.success ? result.data : null
  }
  catch {
    return null
  }
}

function parsePinnedModel(value: AutomationEditorForm) {
  if (!value.pinnedModelKey)
    return null
  const separator = value.pinnedModelKey.indexOf(':')
  if (separator < 1)
    return null
  return {
    mode: 'pinned' as const,
    modelId: value.pinnedModelKey.slice(separator + 1),
    providerId: value.pinnedModelKey.slice(0, separator),
    reasoning: value.reasoning,
  }
}

export function createAutomationEditorForm(currentTime: Temporal.ZonedDateTime): AutomationEditorForm {
  const timezone = currentTime.timeZoneId
  const now = currentTime.with({ second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 })
  const start = now
    .add({ hours: 1 })
    .with({ minute: 0, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 })
  return {
    actorId: null,
    activeFrom: null,
    activeUntil: null,
    anchorLocal: formatWallTime(now),
    cadence: 'daily',
    day: start.day,
    dayOfMonth: start.day,
    every: 1,
    executionProfile: 'workspace_write',
    frequencyMode: 'calendar',
    intervalUnit: 'hour',
    localTime: start.toPlainTime().toString({ smallestUnit: 'minute' }),
    modelMode: 'default',
    month: start.month,
    name: '',
    onceLocal: formatWallTime(start),
    pinnedModelKey: null,
    spaceId: null,
    prompt: '',
    reasoning: null,
    timezone,
    weekdays: [start.dayOfWeek],
  }
}

export function automationEditorFormFromDefinition(
  automation: Pick<LocalAutomation, keyof AutomationDefinitionDraft>,
  currentTime: Temporal.ZonedDateTime,
): AutomationEditorForm {
  const next = createAutomationEditorForm(currentTime.withTimeZone(automation.timing.timezone))
  next.actorId = automation.actorId ?? null
  next.activeFrom = automation.timing.activeFrom
  next.activeUntil = automation.timing.activeUntil
  next.executionProfile = automation.executionProfile
  next.modelMode = automation.model.mode
  next.name = automation.name
  next.spaceId = automation.spaceId
  next.prompt = automation.prompt
  if (automation.model.mode === 'pinned') {
    next.pinnedModelKey = `${automation.model.providerId}:${automation.model.modelId}`
    next.reasoning = automation.model.reasoning
  }
  const schedule = automation.timing.schedule
  next.frequencyMode = schedule.kind
  if (schedule.kind === 'once') {
    next.onceLocal = instantToWallTime(schedule.runAt, next.timezone)
  }
  else if (schedule.kind === 'interval') {
    next.anchorLocal = instantToWallTime(schedule.anchorAt, next.timezone)
    next.every = schedule.every
    next.intervalUnit = schedule.unit
  }
  else {
    next.cadence = schedule.cadence
    next.localTime = schedule.localTime
    if (schedule.cadence === 'weekly')
      next.weekdays = [...schedule.weekdays]
    if (schedule.cadence === 'monthly')
      next.dayOfMonth = schedule.dayOfMonth
    if (schedule.cadence === 'yearly') {
      next.day = schedule.day
      next.month = schedule.month
    }
  }
  return next
}

function wallTimeToInstant(value: string, timezone: string, previousInstant?: string): string {
  if (previousInstant && value === instantToWallTime(previousInstant, timezone))
    return previousInstant
  return Temporal.PlainDateTime.from(value.replace(' ', 'T'))
    .toZonedDateTime(timezone)
    .toInstant()
    .toString({ smallestUnit: 'millisecond' })
}

function instantToWallTime(value: string, timezone: string): string {
  return formatWallTime(Temporal.Instant.from(value).toZonedDateTimeISO(timezone))
}

function formatWallTime(value: Temporal.ZonedDateTime): string {
  return `${value.toPlainDate()} ${value.toPlainTime().toString({ smallestUnit: 'minute' })}`
}
