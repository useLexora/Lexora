import type { BuddyComposerResource } from '@buddy-shared/conversation/composerResource'

export function pastedTextLineCount(text: string): number {
  return text.split(/\r\n|\r|\n/u).length
}

export function shouldAttachPastedText(text: string): boolean {
  return text.length > 1500 || pastedTextLineCount(text) > 20
}

export function isPastedTextResource(resource: BuddyComposerResource): boolean {
  return resource.kind === 'text' && resource.nameSource === 'clipboard' && !resource.localReference
}
