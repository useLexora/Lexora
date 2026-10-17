import type { BuddyInputMaterial } from '@buddy-shared/conversation/buddyInputMaterial'
import type { BuddyUserContentV1 } from '@buddy-shared/conversation/buddyUserContent'
import type { BuddyComposerResource } from '@buddy-shared/conversation/composerResource'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { getBuddyInputMaterials } from '@buddy-shared/conversation/buddyInputMaterial'
import { translateBuddy } from '@/i18n/buddyI18n'

export interface InputResourceView {
  resource: Pick<BuddyComposerResource, 'name' | 'sizeBytes' | 'state'> & { kind: BuddyComposerResource['kind'] | 'file', path?: string }
  previewUrl: string | null
  imageLabel?: string
  canRetry?: boolean
  textPreview?: boolean
  textLineCount?: number
}

export type InputMaterialView = Exclude<BuddyInputMaterial, { kind: 'resource' }> | (Extract<BuddyInputMaterial, { kind: 'resource' }> & InputResourceView)

export function getInputMaterialViews(content: BuddyUserContentV1, resource: (id: string) => InputResourceView | undefined): InputMaterialView[] {
  return getBuddyInputMaterials(content).flatMap((material): InputMaterialView[] => {
    if (material.kind !== 'resource')
      return [material]
    const view = resource(material.id)
    return view ? [{ ...material, ...view }] : []
  })
}

export function inputMaterialLabel(material: Exclude<BuddyInputMaterial, { kind: 'resource' }>, language: BuddyLocale): string {
  if (material.kind === 'session')
    return material.reference.title
  if (material.kind === 'message_quote')
    return translateBuddy(language, material.quote.source.role === 'assistant' ? 'desktop.chat.quoteFromAssistant' : 'desktop.chat.quoteFromUser')
  const quote = material.quote
  const title = quote.source.kind === 'artifact' ? `${translateBuddy(language, 'desktop.chat.turnOutputs')} · ${quote.source.title}` : quote.source.title
  return `${title}${!('element' in quote) && quote.range ? ` · L${quote.range.startLineNumber}–${quote.range.endLineNumber}` : ''}`
}

export function inputMaterialText(material: InputMaterialView): string {
  return material.kind === 'resource' ? material.imageLabel ?? material.resource.name : material.kind === 'session' ? material.reference.title : material.quote.text
}
