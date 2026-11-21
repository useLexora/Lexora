import type { InjectionKey, Ref } from 'vue'
import type { ReaderStepDetailReply } from './readerProtocol'

export const readerStepDetailKey: InjectionKey<Readonly<Ref<ReaderStepDetailReply | undefined>>> = Symbol('reader-step-detail')
let request = 0
export function nextStepRead() {
  return `step:${++request}`
}
