import lexora from './assets/peeking.png'
import whale from './assets/whale-peeking.png'

export function resolveCompanionStickerImage(image: string): string {
  return image === 'whale' ? whale : image === 'lexora' ? lexora : image
}
