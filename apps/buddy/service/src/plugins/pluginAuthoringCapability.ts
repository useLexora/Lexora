import type { RuntimeRpcPeerContract } from '../../../shared/runtime/rpcPeer'
import type { BuddyCapability, BuddyCapabilityContext } from '../agent/extensions/BuddyCapability'
import { Buffer } from 'node:buffer'
import { open, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { defineTool } from '@earendil-works/pi-coding-agent'
import { zipSync } from 'fflate/browser'
import { Type } from 'typebox'
import { Check } from 'typebox/value'
import { readExtensionDirectory } from '../../../platform/extensions/extensionFiles'
import { containsCanonicalPath } from '../../../platform/filesystem/filePaths'
import { EXTENSION_BUILD_RPC, EXTENSION_REVIEW_REQUEST, extensionBuildResultSchema } from '../../../shared/extensions/extensionAuthoring'
import { resolveGrantedPath } from '../directories/resolveGrantedPath'

const name = 'lexora_plugin_build'
const parameters = Type.Object({
  source: Type.String({ minLength: 1, maxLength: 4096, description: 'Plugin source directory containing extension.json, relative to the workspace or absolute.' }),
  output: Type.String({ minLength: 1, maxLength: 4096, description: 'New .lexora-extension file outside the source directory. Existing files are never overwritten.' }),
  review: Type.Optional(Type.Boolean({ description: 'Show the user an installation review after building. Never installs automatically.' })),
}, { additionalProperties: false })

export function createPluginAuthoringCapability(context: BuddyCapabilityContext, peer: Pick<RuntimeRpcPeerContract, 'request' | 'notify'>): BuddyCapability {
  return {
    classify(event) {
      if (event.toolName !== name)
        return null
      if (!Check(parameters, event.input))
        return { blocked: true, reason: 'VALIDATION_FAILED' }
      return { access: 'write', paths: [{ path: event.input.source, mode: 'existing' }, { path: event.input.output, mode: 'create' }] }
    },
    disclosure: { group: 'plugins', keywords: 'plugin extension build create 插件 创建 编译 校验 安装', toolNames: [name] },
    extension: {
      name: 'lexora-plugin-authoring',
      factory(pi) {
        pi.registerTool(defineTool({
          name,
          label: 'Build plugin',
          parameters,
          description: 'Validate and compile a self-contained Lexora TS/JS plugin using the isolated built-in compiler, and write an installable package. Returns diagnostics for repair. Does not run plugin code, install dependencies or install plugins. Optionally opens the user installation review.',
          async execute(toolCallId, input, signal) {
            const diagnostics: string[] = []
            try {
              if (!Check(parameters, input))
                throw new Error('VALIDATION_FAILED')
              const abort = signal ? AbortSignal.any([signal, context.signal]) : context.signal
              abort.throwIfAborted()
              const grants = context.getExecutionGrants?.(toolCallId) ?? context.grants
              const source = await resolveGrantedPath(grants, resolve(context.cwd, input.source), 'existing')
              const output = await resolveGrantedPath(grants, resolve(context.cwd, input.output), 'create')
              if (!output.canonicalPath.endsWith('.lexora-extension'))
                throw new Error('EXTENSION_OUTPUT_INVALID')
              if (containsCanonicalPath(source.canonicalPath, output.canonicalPath))
                throw new Error('EXTENSION_OUTPUT_INVALID')
              const files = await readExtensionDirectory(source.canonicalPath)
              const archive = Buffer.from(zipSync(Object.fromEntries(files), { level: 6 })).toString('base64')
              const result = extensionBuildResultSchema.parse(await peer.request(EXTENSION_BUILD_RPC, { archive }, 45000, abort))
              diagnostics.push(...result.diagnostics)
              if (!result.ok)
                return response({ ok: false, code: result.code, diagnostics })
              abort.throwIfAborted()
              const currentOutput = await resolveGrantedPath(grants, resolve(context.cwd, input.output), 'create')
              if (currentOutput.canonicalPath !== output.canonicalPath)
                throw new Error('EXTENSION_OUTPUT_CHANGED')
              const handle = await open(output.canonicalPath, 'wx', 0o600)
              try {
                await handle.writeFile(Buffer.from(result.archive, 'base64'), { signal: abort })
                await handle.sync()
              }
              catch (error) {
                await handle.close()
                await rm(output.canonicalPath, { force: true })
                throw error
              }
              finally { await handle.close() }
              if (input.review)
                peer.notify(EXTENSION_REVIEW_REQUEST, { path: output.canonicalPath })
              return response({ ok: true, id: result.id, version: result.version, packagePath: output.canonicalPath, diagnostics, reviewRequested: input.review === true, installed: false, runtimeTested: false })
            }
            catch (error) {
              const code = (error as { code?: string }).code ?? (error instanceof Error ? error.message : '')
              return response({ ok: false, code: /^[A-Z][A-Z_]+$/.test(code) ? code : 'EXTENSION_BUILD_FAILED', diagnostics })
            }
          },
        }))
        pi.on('tool_result', (event) => {
          if (event.toolName === name && event.details && typeof event.details === 'object' && 'ok' in event.details && event.details.ok === false)
            return { isError: true }
        })
      },
    },
  }
}

function response(value: Record<string, unknown> & { ok: boolean }) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: value, isError: !value.ok }
}
