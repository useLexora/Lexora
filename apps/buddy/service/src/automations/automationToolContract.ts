import type {
  Automation,
  AutomationOccurrence,
  AutomationRunNowResult,
} from '../../../shared/automation'
import type { BuddyToolPresentation } from '../../../shared/runs/runEventPresentation'
import type { CreateBuddyToolPresentationInput } from '../events/toolPresentationSupport'
import type { AutomationPage } from './AutomationService'
import { toPiToolGroup } from '../agent/extensions/piToolGroup'

import {
  readArrayLength,
  readOptionalString,
  readRecord,
  readToolDetails,
} from '../events/toolPresentationSupport'

export const AUTOMATION_TOOLS = toPiToolGroup({ name: 'lexora_automation', description: 'Manage scheduled tasks, recurring runs, and reminders.', tools: [{ name: 'manage' }] }, { manage: 'lexora_buddy_automation' })

export const AUTOMATION_TOOL_NAME = AUTOMATION_TOOLS.manage.name

export type AutomationToolOperation
  = | 'list'
    | 'get'
    | 'upsert'
    | 'pause'
    | 'resume'
    | 'delete'
    | 'run_now'

export interface AutomationToolDetails {
  automation?: Automation
  code?: string
  occurrence?: AutomationOccurrence
  operation: AutomationToolOperation | 'invalid'
  page?: AutomationPage<Automation>
  runNowOutcome?: AutomationRunNowResult['outcome']
}

export function createAutomationToolPresentation(
  input: CreateBuddyToolPresentationInput,
): Extract<BuddyToolPresentation, { card: 'automation' }> | null {
  if (input.toolName !== AUTOMATION_TOOL_NAME)
    return null
  const arguments_ = readRecord(input.arguments)
  const details = readToolDetails(input.result)
  const automation = readRecord(details?.automation)
    ?? readRecord(arguments_?.draft)
  const occurrence = readRecord(details?.occurrence)
  const page = readRecord(details?.page)
  return {
    automationId: readOptionalString(automation, 'id')
      ?? readOptionalString(occurrence, 'automationId')
      ?? readOptionalString(arguments_, 'automationId'),
    card: 'automation',
    itemCount: readArrayLength(page, 'items'),
    name: readOptionalString(automation, 'name'),
    nextRunAt: readOptionalString(automation, 'nextRunAt'),
    occurrenceId: readOptionalString(occurrence, 'id'),
    operation: readAutomationOperation(details, arguments_),
    status: readOptionalString(occurrence, 'status')
      ?? readOptionalString(automation, 'status')
      ?? (input.result ? null : 'running'),
  }
}

function readAutomationOperation(
  details: Record<string, unknown> | null,
  arguments_: Record<string, unknown> | null,
): Extract<BuddyToolPresentation, { card: 'automation' }>['operation'] {
  const operation = readOptionalString(details, 'operation')
    ?? readOptionalString(arguments_, 'operation')
  switch (operation) {
    case 'list':
    case 'get':
    case 'upsert':
    case 'pause':
    case 'resume':
    case 'delete':
    case 'run_now':
      return operation
    default:
      return 'list'
  }
}
