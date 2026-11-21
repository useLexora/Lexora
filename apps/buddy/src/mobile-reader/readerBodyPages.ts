import type { InjectionKey, Ref } from 'vue'
import type { ReaderUpdate } from './readerProtocol'

export const readerBodyPageKey: InjectionKey<Readonly<Ref<ReaderUpdate['bodyPage']>>> = Symbol('reader-body-page')
