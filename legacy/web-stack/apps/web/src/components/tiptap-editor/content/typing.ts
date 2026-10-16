/**
 * 已上传图片资源。
 */
export interface TiptapEditorUploadedImage {
  /** 资源 ID */
  id: string
  /** 文件名 */
  fileName: string
  /** 资源地址 */
  contentUrl: string | null
  /** 图片宽度 */
  width: number | null
  /** 图片高度 */
  height: number | null
}

/**
 * 已上传附件资源。
 */
export interface TiptapEditorUploadedFile {
  /** 资源 ID */
  id: string
  /** 文件名 */
  fileName: string
  /** MIME 类型 */
  mimeType: string
  /** 文件大小 */
  size: number
  /** 资源地址 */
  contentUrl: string | null
}

export type TiptapEditorResolveImageSrc = (assetId: string) => string | null | Promise<string | null>
