import { toPiToolGroup } from '../agent/extensions/piToolGroup'

export const IMAGE_TOOLS = toPiToolGroup({ name: 'lexora_image', description: 'Read images, discover visible image references, generate images, or remove a solid chroma background.', tools: [{ name: 'read' }, { name: 'list' }, { name: 'generate' }, { name: 'chroma_key' }] })
