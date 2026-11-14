import type { InjectionKey, Ref } from 'vue'
import { inject, shallowRef } from 'vue'

export const readerCopyFeedbackKey: InjectionKey<Readonly<Ref<string | null>>> = Symbol('reader-copy-feedback')
export const useReaderCopyFeedback = () => inject(readerCopyFeedbackKey, shallowRef(null))
