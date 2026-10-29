import { readLimitedResponse } from '../sync/SyncAdapter'

export async function speechRequestError(response: Response): Promise<Error> {
  let code = response.status === 401 ? 'UNAUTHORIZED' : response.status === 403 ? 'FORBIDDEN' : response.status === 402 ? 'QUOTA_EXCEEDED' : response.status === 429 ? 'BUSY' : 'FAILED'
  try {
    const data = JSON.parse(new TextDecoder().decode(await readLimitedResponse(response, 32 * 1024)))
    const status: unknown = data?.error?.code
    if (['insufficient_permissions', 'forbidden'].includes(status as string))
      code = 'FORBIDDEN'
    else if (['insufficient_quota', 'quota_exceeded'].includes(status as string))
      code = 'QUOTA_EXCEEDED'
    else if (['invalid_api_key', 'missing_api_key'].includes(status as string))
      code = 'UNAUTHORIZED'
  }
  catch {}
  return new Error(`SPEECH_SERVICE_${code}`)
}
