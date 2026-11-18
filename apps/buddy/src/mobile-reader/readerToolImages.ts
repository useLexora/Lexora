import type { InjectionKey, Ref } from 'vue'
import type { ReaderSend, ReaderToolImage } from './readerProtocol'

export const readerToolImagesKey: InjectionKey<Readonly<Ref<ReaderToolImage[]>>> = Symbol('reader-tool-images')
export const readerToolImageHostKey: InjectionKey<{ runId: Readonly<Ref<string>>, send: ReaderSend }> = Symbol('reader-tool-image-host')
