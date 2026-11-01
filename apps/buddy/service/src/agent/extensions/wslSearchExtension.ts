import type { RunWslSearch } from '../../wsl/wslProcess'
import type { BuddyInProcessExtension } from './BuddyInProcessExtension'
import { createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition } from '@earendil-works/pi-coding-agent'
import { sharedWslHosts } from '../../wsl/sharedWslHosts'
import { executeWslFind, executeWslGrep, executeWslLs, resolveWslPath } from '../../wsl/wslSearch'

export const WSL_SEARCH_EXTENSION = 'lexora-wsl-search'

// grep, find and ls keep the built-in tools' schemas, descriptions and renderers. Only a target inside a WSL distribution
// runs elsewhere (in the distribution); it never falls back to walking \\wsl.localhost, which is what made these slow.
export function createWslSearchExtension(cwd: string, run: RunWslSearch = sharedWslHosts.run): BuddyInProcessExtension {
  return {
    name: WSL_SEARCH_EXTENSION,
    factory(pi) {
      const grep = createGrepToolDefinition(cwd)
      pi.registerTool({
        ...grep,
        async execute(toolCallId, input, signal, onUpdate, context) {
          const target = resolveWslPath(input.path, context?.cwd || cwd)
          return target ? executeWslGrep(target, input, signal, run) : grep.execute(toolCallId, input, signal, onUpdate, context)
        },
      })
      const find = createFindToolDefinition(cwd)
      pi.registerTool({
        ...find,
        async execute(toolCallId, input, signal, onUpdate, context) {
          const target = resolveWslPath(input.path, context?.cwd || cwd)
          return target ? executeWslFind(target, input, signal, run) : find.execute(toolCallId, input, signal, onUpdate, context)
        },
      })
      const ls = createLsToolDefinition(cwd)
      pi.registerTool({
        ...ls,
        async execute(toolCallId, input, signal, onUpdate, context) {
          const target = resolveWslPath(input.path, context?.cwd || cwd)
          return target ? executeWslLs(target, input, signal, run) : ls.execute(toolCallId, input, signal, onUpdate, context)
        },
      })
    },
  }
}
