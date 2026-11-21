import type { InjectionKey, Ref } from 'vue'

export const readerTurnWindowKey: InjectionKey<Readonly<Ref<boolean>>> = Symbol('reader-turn-window')
