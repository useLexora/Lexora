import type { NodeViewRendererProps } from '@tiptap/core'
import type { ImageOptions } from '@tiptap/extension-image'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { TiptapEditorResolveImageSrc } from '../content/typing'
import Image from '@tiptap/extension-image'

interface DocumentImageOptions extends ImageOptions {
  resolveImageSrc?: TiptapEditorResolveImageSrc
}

export const DocumentImage = Image.extend<DocumentImageOptions>({
  addOptions() {
    return {
      inline: false,
      allowBase64: false,
      HTMLAttributes: {},
      resize: false,
      ...this.parent?.(),
      resolveImageSrc: undefined,
    }
  },

  addAttributes() {
    return {
      ...this.parent?.(),
      assetId: {
        default: null,
        parseHTML: element => element.getAttribute('data-asset-id'),
        renderHTML: (attributes) => {
          if (typeof attributes.assetId !== 'string' || !attributes.assetId.length) {
            return {}
          }

          return {
            'data-asset-id': attributes.assetId,
          }
        },
      },
      alt: {
        default: null,
      },
      width: {
        default: null,
      },
      height: {
        default: null,
      },
      textAlign: {
        default: null,
        parseHTML: element => resolveImageTextAlign(element),
        renderHTML: (attributes) => {
          if (!isImageTextAlign(attributes.textAlign)) {
            return {}
          }

          return {
            'data-align': attributes.textAlign,
            'style': resolveImageAlignStyle(attributes.textAlign),
          }
        },
      },
      caption: {
        default: null,
        parseHTML: element => element.getAttribute('data-caption'),
        renderHTML: (attributes) => {
          if (typeof attributes.caption !== 'string' || !attributes.caption.length) {
            return {}
          }

          return {
            'data-caption': attributes.caption,
          }
        },
      },
      src: {
        default: null,
      },
    }
  },

  parseHTML() {
    return [
      {
        tag: 'img[data-asset-id]',
      },
    ]
  },

  addNodeView() {
    const resolveImageSrc = this.options.resolveImageSrc

    return props => createDocumentImageNodeView(props, resolveImageSrc)
  },
})

function createDocumentImageNodeView(
  props: NodeViewRendererProps,
  resolveImageSrc: TiptapEditorResolveImageSrc | undefined,
) {
  const image = document.createElement('img')
  let resolveRequestId = 0

  function render(node: ProseMirrorNode) {
    renderStaticImageAttributes(image, node.attrs)
    const currentRequestId = ++resolveRequestId
    void resolveAndApplyImageSrc(
      image,
      node.attrs,
      resolveImageSrc,
      () => currentRequestId === resolveRequestId,
    )
  }

  render(props.node)

  return {
    dom: image,
    update(nextNode: ProseMirrorNode) {
      if (nextNode.type !== props.node.type) {
        return false
      }

      render(nextNode)
      return true
    },
    destroy() {
      resolveRequestId += 1
    },
  }
}

function renderStaticImageAttributes(image: HTMLImageElement, attributes: Record<string, unknown>) {
  const assetId = typeof attributes.assetId === 'string' ? attributes.assetId : ''
  const alt = typeof attributes.alt === 'string' ? attributes.alt : ''
  const width = typeof attributes.width === 'number' ? attributes.width : null
  const height = typeof attributes.height === 'number' ? attributes.height : null
  const caption = typeof attributes.caption === 'string' ? attributes.caption : ''

  applyOptionalAttribute(image, 'data-asset-id', assetId)
  applyOptionalAttribute(image, 'alt', alt)
  applyOptionalAttribute(image, 'width', width === null ? '' : String(width))
  applyOptionalAttribute(image, 'height', height === null ? '' : String(height))
  applyOptionalAttribute(image, 'data-caption', caption)

  if (isImageTextAlign(attributes.textAlign)) {
    image.dataset.align = attributes.textAlign
    image.setAttribute('style', resolveImageAlignStyle(attributes.textAlign))
  }
  else {
    image.removeAttribute('data-align')
    image.removeAttribute('style')
  }
}

async function resolveAndApplyImageSrc(
  image: HTMLImageElement,
  attributes: Record<string, unknown>,
  resolveImageSrc: TiptapEditorResolveImageSrc | undefined,
  isCurrentRequest: () => boolean,
) {
  const assetId = typeof attributes.assetId === 'string' ? attributes.assetId : ''

  if (!assetId) {
    image.removeAttribute('src')
    return
  }

  const attrSrc = typeof attributes.src === 'string' && attributes.src.length ? attributes.src : null

  if (attrSrc) {
    image.src = attrSrc
    return
  }

  const resolvedSrc = await safelyResolveImageSrc(resolveImageSrc, assetId)

  if (!isCurrentRequest()) {
    return
  }

  if (resolvedSrc) {
    image.src = resolvedSrc
    return
  }

  image.removeAttribute('src')
}

async function safelyResolveImageSrc(
  resolveImageSrc: TiptapEditorResolveImageSrc | undefined,
  assetId: string,
) {
  try {
    return await resolveImageSrc?.(assetId)
  }
  catch {
    return null
  }
}

function applyOptionalAttribute(image: HTMLImageElement, name: string, value: string) {
  if (!value) {
    image.removeAttribute(name)
    return
  }

  image.setAttribute(name, value)
}

function resolveImageTextAlign(element: HTMLElement) {
  const textAlign = element.getAttribute('data-align')

  if (isImageTextAlign(textAlign)) {
    return textAlign
  }

  const marginLeft = element.style.marginLeft
  const marginRight = element.style.marginRight

  if (marginLeft === 'auto' && marginRight === 'auto') {
    return 'center'
  }

  if (marginLeft === 'auto') {
    return 'right'
  }

  return undefined
}

function resolveImageAlignStyle(value: 'left' | 'center' | 'right') {
  switch (value) {
    case 'center':
      return 'display: block; margin-left: auto; margin-right: auto;'
    case 'right':
      return 'display: block; margin-left: auto; margin-right: 0;'
    default:
      return 'display: block; margin-left: 0; margin-right: auto;'
  }
}

function isImageTextAlign(value: unknown): value is 'left' | 'center' | 'right' {
  return value === 'left' || value === 'center' || value === 'right'
}
