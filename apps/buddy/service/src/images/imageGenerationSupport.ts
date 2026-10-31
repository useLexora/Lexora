import type { ImageSupport } from '../../../shared/images/imagePreferences'

export const nativeImageSupport: ImageSupport = {
  operations: ['generate', 'edit'],
  maxReferenceImages: 4,
  sizes: ['auto', '1024x1024', '1536x1024', '1024x1536'],
  qualities: ['auto', 'low', 'medium', 'high'],
  backgrounds: ['auto', 'opaque', 'transparent'],
}
