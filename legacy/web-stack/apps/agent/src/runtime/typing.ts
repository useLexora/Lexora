import type {
  AgentGenerationCommand,
  AgentRuntimeControlCommand,
  AgentRuntimeControlResult,
  AgentRuntimeModelTarget,
  ChatGenerationBootstrap,
  ChatGenerationEvent,
} from '@haohaoxue/lexora-contracts'

export type {
  AgentGenerationCommand,
  AgentRuntimeControlCommand,
  AgentRuntimeControlResult,
  AgentRuntimeModelTarget,
  ChatGenerationBootstrap,
  ChatGenerationEvent,
}

export type AgentQueueCommand = AgentGenerationCommand
export type AgentCommandHandler = (command: AgentQueueCommand) => Promise<void> | void
export type AgentControlHandler = (control: AgentRuntimeControlCommand) => Promise<void> | void

export interface AgentCommandQueue {
  publish: (command: AgentQueueCommand) => Promise<void>
  publishControl?: (control: AgentRuntimeControlCommand) => Promise<void>
  subscribe: (handler: AgentCommandHandler) => () => void
  subscribeControl?: (handler: AgentControlHandler) => () => void
  ready?: () => Promise<void>
  close?: () => Promise<void>
}

export interface AgentGenerationBootstrapClient {
  getGenerationBootstrap: (options: { generationId: string }) => Promise<ChatGenerationBootstrap>
}

export interface AgentRunner {
  submit: (command: AgentGenerationCommand) => Promise<unknown>
  cancel: (generationId: string) => boolean
}

export interface AgentEventPublisher {
  publish: (event: ChatGenerationEvent) => Promise<void>
  close?: () => Promise<void>
}

export interface AgentControlResultPublisher {
  publish: (result: AgentRuntimeControlResult) => Promise<void>
  close?: () => Promise<void>
}
