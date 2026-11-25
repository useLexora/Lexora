import { readModelLaunchFailure } from './modelLaunchFailure'

const feedback = {
  MODEL_LAUNCH_QUOTA_EXCEEDED: {
    stage: 'launch',
    location: 'unknown',
    reason: 'quota_exceeded',
    summary: 'The local model could not start: its launch directory could not be prepared because the storage quota was exceeded.',
  },
  MODEL_LAUNCH_NO_SPACE: {
    stage: 'launch',
    location: 'unknown',
    reason: 'no_space',
    summary: 'The local model could not start: its launch directory could not be prepared because no space was left on the device.',
  },
  MODEL_STORAGE_QUOTA_EXCEEDED: {
    stage: 'unknown',
    location: 'unknown',
    reason: 'quota_exceeded',
    summary: 'Local inference failed because the storage quota was exceeded. The affected location is unknown.',
  },
  MODEL_STORAGE_NO_SPACE: {
    stage: 'unknown',
    location: 'unknown',
    reason: 'no_space',
    summary: 'Local inference failed because no space was left on the device. The affected location is unknown.',
  },
  MODEL_STORAGE_FULL: {
    stage: 'unknown',
    location: 'unknown',
    reason: 'storage_full_or_quota_exceeded',
    summary: 'Local inference reported insufficient storage. The affected location and whether space or quota was exhausted are unknown.',
  },
  MODEL_REQUEST_FAILED: {
    stage: 'unknown',
    location: 'unknown',
    reason: 'unknown',
    summary: 'The model request failed. The cause is unknown.',
  },
} as const

export type ModelFailureFeedbackCode = keyof typeof feedback

export function modelFailureFeedback(code: string | null | undefined, launchFailure?: unknown) {
  if (!code || !Object.hasOwn(feedback, code))
    return undefined
  const key = code as ModelFailureFeedbackCode
  const fact = feedback[key]
  if (fact.stage !== 'launch')
    return { code: key, ...fact }
  const location = readModelLaunchFailure(key, launchFailure)?.location
  return {
    code: key,
    ...fact,
    location: location ?? 'unknown',
    summary: `${fact.summary} ${location ? `Launch directory: ${location}.` : 'The directory path was not recorded.'}`,
  }
}
