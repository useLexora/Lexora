import type { ExtensionCompiler } from '../../../platform/extensions/compileExtensionSource'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { utilityProcess } from 'electron'
import { validateExtensionFiles } from '../../../platform/extensions/extensionFiles'

export const compileExtension: ExtensionCompiler = (files, manifest, signal, report) => new Promise((resolve, reject) => {
  signal.throwIfAborted()
  const child = utilityProcess.fork(join(import.meta.dirname, 'extension-compiler.js'), [], { serviceName: 'Lexora Plugin Compiler', stdio: 'pipe', execArgv: ['--max-old-space-size=192'], env: {} })
  let settled = false
  const timer = setTimeout(() => finish(new Error('EXTENSION_COMPILE_TIMEOUT')), 30000)
  const aborted = () => finish(new Error('EXTENSION_INSTALL_CANCELLED'))
  signal.addEventListener('abort', aborted, { once: true })
  let stderrLength = 0
  child.stderr?.on('data', (chunk) => {
    if (stderrLength >= 2048)
      return
    const text = String(chunk).replaceAll(import.meta.dirname, '<compiler>').replaceAll(homedir(), '~')
    stderrLength += text.length
    report(text.slice(0, 600))
  })
  child.stdout?.resume()
  function finish(error: Error | null, result?: Map<string, Uint8Array>) {
    if (settled)
      return
    settled = true
    clearTimeout(timer)
    signal.removeEventListener('abort', aborted)
    child.kill()
    if (error)
      reject(error)
    else resolve(result!)
  }
  child.on('spawn', () => {
    if (settled)
      child.kill()
    else child.postMessage({ files: [...files], manifest })
  })
  child.on('exit', () => finish(new Error('EXTENSION_COMPILER_STOPPED')))
  child.on('message', (message) => {
    if (settled)
      return
    try {
      if (message.kind === 'log') {
        report(String(message.message).slice(0, 600))
      }
      else if (message.kind === 'error') {
        finish(new Error(/^EXTENSION_[A-Z_]+$/.test(message.code) ? message.code : 'EXTENSION_SOURCE_COMPILE_FAILED'))
      }
      else if (message.kind === 'result') {
        const result = new Map<string, Uint8Array>(message.files)
        validateExtensionFiles(result)
        finish(null, result)
      }
    }
    catch {
      finish(new Error('EXTENSION_SOURCE_COMPILE_FAILED'))
    }
  })
})
