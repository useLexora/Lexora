import type { ComputedRef, InjectionKey } from 'vue'
import type { BuddyLocale } from '@/i18n/buddyI18n'

export type MarkdownRemoteImagePolicy = 'block' | 'allow'

export type MarkdownImageResolution
  = | { kind: 'default' }
    | { kind: 'local', src: string }
    | { kind: 'unavailable' }

export type MarkdownImageResolver = (src: string) => MarkdownImageResolution | Promise<MarkdownImageResolution>

interface MarkdownImageContext {
  resolve: ComputedRef<MarkdownImageResolver | undefined>
  remoteImages: ComputedRef<MarkdownRemoteImagePolicy>
  language: ComputedRef<BuddyLocale>
}

export const markdownImageContextKey: InjectionKey<MarkdownImageContext> = Symbol('markdownImageContext')
