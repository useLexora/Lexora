import type { BuiltinPromptCatalog } from '@buddy-shared/prompts/promptApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { BUDDY_EXECUTION_PROFILES } from '@buddy-shared/permissions/executionProfile'
import { translateBuddy } from '@/i18n/buddyMessages'

export interface PromptVariant {
  id: string
  label: string
  content: string
}

export interface PromptEntry {
  id: string
  kind: 'system' | 'template'
  title: string
  command?: string
  description: string
  defaultVariantId: string
  variants: readonly PromptVariant[]
}

export function createBuiltinPromptEntries(catalog: BuiltinPromptCatalog, language: BuddyLocale): readonly PromptEntry[] {
  const t = (key: Parameters<typeof translateBuddy>[1]) => translateBuddy(language, key)
  return (['system', 'execution', 'approval', 'attachments', 'review'] as const).map(id => ({
    id,
    kind: id === 'review' ? 'template' : 'system',
    title: t(`desktop.prompts.title.${id}`),
    command: id === 'review' ? '/review' : undefined,
    description: t(`desktop.prompts.description.${id}`),
    defaultVariantId: id === 'execution' ? 'workspace_write' : 'original',
    variants: id === 'execution'
      ? BUDDY_EXECUTION_PROFILES.map(profile => ({
          id: profile,
          label: t(`desktop.prompts.profile.${profile}`),
          content: catalog.execution[profile],
        }))
      : [{ id: 'original', label: t(`desktop.prompts.title.${id}`), content: catalog[id] }],
  }))
}
