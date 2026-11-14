export type { TaskCapability, TaskChatWorkspace } from './contracts'
export type { TaskContextTab } from './model/context-panel/taskContextPanel'
export { createChatAgentActivityProjector } from './model/transcript/chatAgentActivities'
export { createChatAgentTurnReducer } from './model/transcript/chatAgentTurn'
export { projectDesktopTerminalTranscript } from './model/transcript/terminalTranscript'
export { createFileLinkMenu } from './state/artifacts/createFileLinkMenu'
export { useTaskResourcePanel } from './state/context-panel/useTaskResourcePanel'

export { provideExecutionEnvironment } from './state/runs/chatExecutionContext'
export { createUserQuestionInteractionState } from './state/runs/useUserQuestions'

export { useTaskIndex } from './state/task-index/useTaskIndex'
export type { TaskIndexController } from './state/task-index/useTaskIndex'

export type { UseTaskCapabilityOptions } from './state/useTaskCapability'

export { useTaskCapability } from './state/useTaskCapability'
export type { TaskContext } from './taskContext'

export { useProvideTaskContext, useProvideTaskEnvironment, useTaskContext, useTaskEnvironment } from './taskContext'

export { useProvideArtifactActions } from './widgets/artifacts/artifactActionsContext'
export { sessionReferenceNavigationKey } from './widgets/references/sessionReferenceNavigation'
export { useProvideChatContent } from './widgets/transcript/chatContentContext'
export { provideChatTranscriptPresentation, provideChatTranscriptRowState, useChatTranscriptValue } from './widgets/transcript/chatTranscriptPresentation'
