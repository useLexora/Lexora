import type { ToolCall, ToolMessage } from '@langchain/core/messages'
import type { StructuredToolInterface } from '@langchain/core/tools'
import type { AgentGraphContext } from '../../../state'
import type { RuntimeSkillActionProvider } from '../types'
import type { McpToolCallResult, McpToolClient, McpToolDefinition } from './client'
import { ToolMessage as LangChainToolMessage } from '@langchain/core/messages'
import { tool } from '@langchain/core/tools'
import { z } from 'zod'

interface McpMappedTool {
  localName: string
  remoteName: string
  definition: McpToolDefinition
  argumentsSchema: z.ZodType<Record<string, unknown>>
}

interface McpSkillClientFactoryInput {
  context: AgentGraphContext | undefined
}

export function createStaticMcpSkillActionProvider(input: {
  skillKey: string
  localToolNamePrefix: string
  tools: readonly McpToolDefinition[]
  isAvailable?: (input: McpSkillClientFactoryInput) => boolean
  createClient: (input: McpSkillClientFactoryInput) => McpToolClient | null
}): RuntimeSkillActionProvider {
  const mappedTools = mapMcpTools({
    prefix: input.localToolNamePrefix,
    tools: input.tools,
  })

  return {
    key: input.skillKey,
    actionNames: mappedTools.map(item => item.localName),
    isAvailable(availableInput) {
      return mappedTools.length > 0 && (input.isAvailable?.({
        context: availableInput.context,
      }) ?? Boolean(input.createClient({
        context: availableInput.context,
      })))
    },
    createTools() {
      return mappedTools.map(item => createMcpRuntimeTool(item))
    },
    async executeActions(executeInput) {
      const toolMessages: ToolMessage[] = []
      const client = input.createClient({
        context: executeInput.context,
      })
      const toolByLocalName = new Map(mappedTools.map(item => [item.localName, item]))

      for (const toolCall of executeInput.toolCalls) {
        if (!client) {
          toolMessages.push(createMcpToolMessage(toolCall, {
            status: 'failed',
            reason: 'Skill connector is not configured for this user.',
          }, 'error'))
          continue
        }

        const mappedTool = toolByLocalName.get(toolCall.name)
        if (!mappedTool) {
          toolMessages.push(createMcpToolMessage(toolCall, {
            status: 'failed',
            reason: `Skill action is not available: ${toolCall.name}`,
          }, 'error'))
          continue
        }

        try {
          const result = await callMappedMcpTool(client, mappedTool, toolCall.args)
          toolMessages.push(createMcpToolMessage(
            toolCall,
            renderMcpToolResult(mappedTool, result),
            result.isError ? 'error' : 'success',
          ))
        }
        catch (error) {
          toolMessages.push(createMcpToolMessage(toolCall, {
            status: 'failed',
            reason: formatMcpError(error),
          }, 'error'))
        }
      }

      return { toolMessages }
    },
  }
}

function createMcpRuntimeTool(
  mappedTool: McpMappedTool,
): StructuredToolInterface {
  return tool(async () => {
    return JSON.stringify({
      status: 'failed',
      reason: 'Runtime skill action execution is handled by the Lexora dispatcher.',
    })
  }, {
    name: mappedTool.localName,
    description: createToolDescription(mappedTool),
    schema: mappedTool.argumentsSchema,
  })
}

async function callMappedMcpTool(
  client: McpToolClient,
  mappedTool: McpMappedTool,
  args: unknown,
): Promise<McpToolCallResult> {
  return client.callTool({
    name: mappedTool.remoteName,
    arguments: mappedTool.argumentsSchema.parse(args),
  })
}

function mapMcpTools(input: {
  prefix: string
  tools: readonly McpToolDefinition[]
}): McpMappedTool[] {
  const usedNames = new Set<string>()

  return input.tools.map((definition) => {
    const localName = createUniqueLocalToolName(input.prefix, definition.name, usedNames)
    usedNames.add(localName)

    return {
      localName,
      remoteName: definition.name,
      definition,
      argumentsSchema: createMcpToolArgumentsSchema(definition),
    }
  })
}

function createUniqueLocalToolName(prefix: string, remoteName: string, usedNames: Set<string>): string {
  const baseName = `${normalizeToolName(prefix)}_${normalizeToolName(remoteName)}`
  if (!usedNames.has(baseName)) {
    return baseName
  }

  let index = 2
  let nextName = `${baseName}_${index}`
  while (usedNames.has(nextName)) {
    index += 1
    nextName = `${baseName}_${index}`
  }

  return nextName
}

function normalizeToolName(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

  return normalized || 'tool'
}

function createMcpToolArgumentsSchema(definition: McpToolDefinition): z.ZodType<Record<string, unknown>> {
  const properties = isRecord(definition.inputSchema.properties) ? definition.inputSchema.properties : {}
  const required = new Set(
    Array.isArray(definition.inputSchema.required)
      ? definition.inputSchema.required.filter((item): item is string => typeof item === 'string')
      : [],
  )
  const shape = Object.fromEntries(
    Object.entries(properties).map(([key, value]) => {
      const schema = createZodSchemaFromJsonSchema(value)
      return [key, required.has(key) ? schema : schema.optional()]
    }),
  )

  return z.object(shape).catchall(z.unknown())
}

function createZodSchemaFromJsonSchema(schema: unknown): z.ZodType<unknown> {
  if (!isRecord(schema)) {
    return z.unknown()
  }

  const type = schema.type
  if (type === 'string') {
    return z.string()
  }

  if (type === 'number') {
    return z.number()
  }

  if (type === 'integer') {
    return z.number().int()
  }

  if (type === 'boolean') {
    return z.boolean()
  }

  if (type === 'array') {
    return z.array(createZodSchemaFromJsonSchema(schema.items))
  }

  if (type === 'object') {
    const properties = isRecord(schema.properties) ? schema.properties : {}
    const required = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((item): item is string => typeof item === 'string')
        : [],
    )
    const shape = Object.fromEntries(
      Object.entries(properties).map(([key, value]) => {
        const propertySchema = createZodSchemaFromJsonSchema(value)
        return [key, required.has(key) ? propertySchema : propertySchema.optional()]
      }),
    )

    return z.object(shape).catchall(z.unknown())
  }

  return z.unknown()
}

function createToolDescription(mappedTool: McpMappedTool): string {
  const lines = [
    mappedTool.definition.title ?? mappedTool.definition.name,
    mappedTool.definition.description,
  ].filter((line): line is string => Boolean(line))

  return lines.join(' ')
}

function renderMcpToolResult(mappedTool: McpMappedTool, result: McpToolCallResult): Record<string, unknown> {
  return {
    status: result.isError ? 'error' : 'ok',
    tool: mappedTool.localName,
    content: result.content ?? [],
    structuredContent: result.structuredContent ?? null,
  }
}

function createMcpToolMessage(
  toolCall: ToolCall,
  content: unknown,
  status: 'success' | 'error' = 'success',
): ToolMessage {
  return new LangChainToolMessage({
    tool_call_id: toolCall.id ?? `${toolCall.name}:missing-id`,
    status,
    content: JSON.stringify(content),
  })
}

function formatMcpError(error: unknown): string {
  const message = error instanceof Error && error.message
    ? error.message
    : 'Skill action execution failed.'

  return redactSensitiveQueryParams(message)
}

function redactSensitiveQueryParams(message: string): string {
  return message.replace(
    /([?&](?:key|api_key|apiKey|token|access_token|authorization)=)[^&\s"'<>]+/gi,
    '$1[redacted]',
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
