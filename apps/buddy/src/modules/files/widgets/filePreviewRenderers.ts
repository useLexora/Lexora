import type { FileOpeningProvider } from '@buddy-shared/files/fileOpening'
import type { SpaceFileTarget } from '@buddy-shared/spaces/spaceFileApi'
import type { Component } from 'vue'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import DesktopSvgPreview from '@/shared/ui/media/DesktopSvgPreview.vue'
import DesktopRegisteredFilePreview from './DesktopRegisteredFilePreview.vue'

interface FilePreviewInput {
  ownerId: string
  provider: FileOpeningProvider | null
  target: SpaceFileTarget | null
  name: string
  source: 'working-copy' | 'file'
  resourceReady: boolean
  text?: string
  visible: boolean
  language: BuddyLocale
}

const renderers: Readonly<Record<string, (input: FilePreviewInput) => { component: Component, props: Record<string, unknown> } | null>> = {
  svg: input => input.text === undefined ? null : { component: DesktopSvgPreview, props: { text: input.text, name: input.name } },
  extension: input => input.resourceReady && input.target ? { component: DesktopRegisteredFilePreview, props: { ownerId: input.ownerId, provider: input.provider, target: input.target, text: input.source === 'working-copy' ? input.text : undefined, visible: input.visible, language: input.language } } : null,
}

export function filePreviewRenderer(input: FilePreviewInput) {
  return input.provider ? renderers[input.provider.renderer]?.(input) ?? null : null
}
