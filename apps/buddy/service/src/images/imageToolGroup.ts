import { toPiToolGroup } from '../agent/extensions/piToolGroup'

export const IMAGE_TOOLS = toPiToolGroup({ name: 'lexora_image', description: 'Generate and edit images, or remove a solid chroma background.', tools: [{ name: 'generate' }, { name: 'chroma_key' }] })
