export class ApiError extends Error {
  statusCode: number
  errorCode: string

  constructor(statusCode: number, errorCode: string) {
    super(errorCode)
    this.statusCode = statusCode
    this.errorCode = errorCode
  }
}
