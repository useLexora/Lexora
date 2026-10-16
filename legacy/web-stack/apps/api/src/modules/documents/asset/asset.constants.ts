import { FILE_SIZE_LIMITS } from '@haohaoxue/lexora-contracts/file'
import { prettyBytes } from '@haohaoxue/lexora-shared/file'

export const DOCUMENT_IMAGE_SIZE_LIMIT_LABEL = prettyBytes(FILE_SIZE_LIMITS.DOCUMENT_IMAGE)
export const DOCUMENT_IMAGE_TOO_LARGE_MESSAGE = `图片大小不能超过 ${DOCUMENT_IMAGE_SIZE_LIMIT_LABEL}`
