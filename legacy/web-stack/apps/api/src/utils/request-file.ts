import type { MultipartFile } from '@fastify/multipart'
import type { FastifyRequest } from 'fastify'
import type { Buffer } from 'node:buffer'
import { PayloadTooLargeException } from '@nestjs/common'

type MultipartFastifyRequest = FastifyRequest & {
  file: (options?: {
    limits?: {
      fileSize?: number
    }
  }) => Promise<MultipartFile | undefined>
}

export async function getRequestFile(
  request: FastifyRequest,
  options: {
    maxBytes?: number
  } = {},
): Promise<MultipartFile | undefined> {
  const multipartRequest = request as MultipartFastifyRequest

  if (options.maxBytes === undefined) {
    return await multipartRequest.file()
  }

  return await multipartRequest.file({
    limits: {
      fileSize: options.maxBytes,
    },
  })
}

export async function readRequestFileBuffer(
  file: MultipartFile,
  options: {
    fileTooLargeMessage: string
  },
): Promise<Buffer> {
  try {
    const buffer = await file.toBuffer()

    if (isRequestFileTruncated(file)) {
      throw new PayloadTooLargeException(options.fileTooLargeMessage)
    }

    return buffer
  }
  catch (error) {
    if (isRequestFileTooLargeError(error)) {
      throw new PayloadTooLargeException(options.fileTooLargeMessage)
    }

    throw error
  }
}

function isRequestFileTooLargeError(error: unknown) {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && error.code === 'FST_REQ_FILE_TOO_LARGE',
  )
}

function isRequestFileTruncated(file: MultipartFile) {
  const multipartFile = file as MultipartFile & {
    file?: MultipartFile['file'] & {
      truncated?: unknown
    }
    truncated?: unknown
  }

  return multipartFile.truncated === true || multipartFile.file?.truncated === true
}
