import type { ImageOutputOptions, ImageSupport } from '../../../shared/images/imagePreferences'

export const nativeImageSupport: ImageSupport = {
  operations: ['generate', 'edit'],
  maxReferenceImages: 4,
  sizes: ['auto', '1024x1024', '1536x1024', '1024x1536'],
  qualities: ['auto', 'low', 'medium', 'high'],
  backgrounds: ['auto', 'opaque', 'transparent'],
}

export function supportsImageRequest(support: ImageSupport, operation: 'generate' | 'edit', references: number, output: ImageOutputOptions): boolean {
  return support.operations.includes(operation)
    && references <= support.maxReferenceImages
    && support.sizes.includes(output.size)
    && support.qualities.includes(output.quality)
    && support.backgrounds.includes(output.background)
    && (output.resolution === undefined || support.resolutions?.includes(output.resolution) === true)
    && (output.aspectRatio === undefined || support.aspectRatios?.includes(output.aspectRatio) === true)
}
