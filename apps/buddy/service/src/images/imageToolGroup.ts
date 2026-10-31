import { toPiToolGroup } from '../agent/extensions/piToolGroup'

export const IMAGE_TOOLS = toPiToolGroup({ name: 'lexora_image', description: 'Read image content, generate images using configured models, or remove a solid chroma background.', tools: [{ name: 'read' }, { name: 'generate' }, { name: 'chroma_key' }] })
