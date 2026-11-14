export type CommandAdmissionErrorCode
  = | 'COMMAND_ID_REUSED'
    | 'COMMAND_FINGERPRINT_UNSUPPORTED'
    | 'COMMAND_ACTOR_UNAVAILABLE'
    | 'DATA_GENERATION_CHANGED'
    | 'SERVICE_INSTANCE_CHANGED'
    | 'SERVICE_STOPPING'

export class CommandAdmissionError extends Error {
  readonly code: CommandAdmissionErrorCode

  constructor(code: CommandAdmissionErrorCode, message: string = code) {
    super(message)
    this.code = code
    this.name = 'CommandAdmissionError'
  }
}

export class CommandResultUnknownError extends Error {
  readonly code = 'COMMAND_RESULT_UNKNOWN'
  readonly acceptance = 'unknown'

  constructor(cause: unknown) {
    super('The command decision cannot be determined from this storage connection', { cause })
    this.name = 'CommandResultUnknownError'
  }
}
