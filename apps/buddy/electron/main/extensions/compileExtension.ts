import type { ExtensionCompiler } from '../../../platform/extensions/compileExtensionSource'
import { processExtensionPackageInBackground } from './ExtensionPackageWorker'

export const compileExtension: ExtensionCompiler = (files, manifest, signal, report) => processExtensionPackageInBackground({ kind: 'compile', files, manifest }, signal, report)
