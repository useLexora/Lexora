import type { BuddyCapability } from '../agent/extensions/BuddyCapability'
import type { BuddyInProcessExtension } from '../agent/extensions/BuddyInProcessExtension'

import type { CreatePetToolOptions } from './createPetTool'
import { createPetTool } from './createPetTool'
import { classifyPetTool, PET_TOOL_NAME } from './petToolContract'

export function createPetCapability(options: CreatePetToolOptions): BuddyCapability {
  return {
    extension: createPetExtension(options),
    classify: classifyPetTool,
    disclosure: [{ source: { kind: 'builtin', id: 'pet', title: 'Desktop companion' }, exposure: 'direct', keywords: '桌宠 动作 陪伴 pet companion', tools: [{ name: PET_TOOL_NAME }] }],
  }
}

export function createPetExtension(
  options: CreatePetToolOptions,
): BuddyInProcessExtension {
  return {
    name: 'lexora-pet',
    factory(pi) {
      pi.registerTool(createPetTool(options))
    },
  }
}
