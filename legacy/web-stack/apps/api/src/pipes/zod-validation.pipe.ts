import type { ArgumentMetadata, PipeTransform } from '@nestjs/common'
import { BadRequestException } from '@nestjs/common'
import { ZodError } from 'zod'

export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: { parse: (value: unknown) => unknown }) {}

  transform(value: unknown, _metadata: ArgumentMetadata) {
    try {
      return this.schema.parse(value)
    }
    catch (error) {
      if (error instanceof ZodError) {
        throw new BadRequestException(
          error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`),
        )
      }
      throw error
    }
  }
}
