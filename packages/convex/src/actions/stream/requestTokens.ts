'use node'

import type { ModelMessage, ToolResultOutput } from '@ai-sdk/provider-utils'
import type { ToolSet } from 'ai'

import { estimateTokens } from '../../model/context'
import type { SessionTools } from '../../model/tool/sessionTools'

export type RequestToEstimate = {
  systemPrompt?: string
  messages: ModelMessage[]
  tools: ToolSet
  toolRuntime?: SessionTools
}

export function contextThreshold(contextWindow: number) {
  return Math.ceil(contextWindow * 0.9)
}

export async function estimateMessageTokens(
  message: ModelMessage,
  runtime?: SessionTools,
) {
  return 5 + (await estimateTokens(messageText(message, runtime)))
}

export async function requestToolDefinitions(
  request: Pick<RequestToEstimate, 'toolRuntime' | 'tools'>,
) {
  const { toolDefinitions } = await import('../../model/tool/definitions')
  return (
    request.toolRuntime?.wireDefinitions ??
    (await toolDefinitions(request.tools))
  )
}

type ToolDefinition = Awaited<ReturnType<typeof requestToolDefinitions>>[number]

export function estimateToolTokens({
  name,
  description,
  inputSchema,
}: ToolDefinition) {
  return estimateTokens(`${name}\n${description ?? ''}\n${inputSchema}`)
}

/** Estimates input as prepared, including the tool definitions sent by dispatch. */
export async function reachesCompactionThreshold(
  request: RequestToEstimate,
  contextWindow: number,
) {
  const threshold = contextThreshold(contextWindow)
  let tokens = await estimateTokens(request.systemPrompt ?? '')
  for (const message of request.messages) {
    if (tokens >= threshold) return true
    tokens += await estimateMessageTokens(message, request.toolRuntime)
  }
  if (tokens >= threshold) return true

  for (const tool of await requestToolDefinitions(request)) {
    tokens += await estimateToolTokens(tool)
    if (tokens >= threshold) return true
  }
  return false
}

function messageText(message: ModelMessage, runtime?: SessionTools) {
  if (typeof message.content === 'string') return message.content
  return message.content
    .map((part) => {
      switch (part.type) {
        case 'text':
        case 'reasoning':
          return part.text
        case 'file':
          return inlineFileText(part.data)
        case 'tool-call': {
          const wire = runtime?.wireCalls.get(part.toolCallId)
          return JSON.stringify({
            name: wire?.name ?? part.toolName,
            input: wire ? wire.input : part.input,
          })
        }
        case 'tool-result': {
          const name =
            runtime?.wireCalls.get(part.toolCallId)?.name ?? part.toolName
          return `${name}\n${toolOutputText(part.output)}`
        }
        default:
          return ''
      }
    })
    .join('\n')
}

function toolOutputText(output: ToolResultOutput) {
  switch (output.type) {
    case 'text':
    case 'error-text':
      return output.value
    case 'json':
    case 'error-json':
      return JSON.stringify(output.value)
    case 'execution-denied':
      return output.reason ?? ''
    case 'content':
      return output.value
        .map((part) => {
          if (part.type === 'text') return part.text
          if (part.type === 'file') return inlineFileText(part.data)
          return ''
        })
        .join('\n')
  }
}

function inlineFileText(data: unknown) {
  if (
    data &&
    typeof data === 'object' &&
    'type' in data &&
    data.type === 'text' &&
    'text' in data
  ) {
    return typeof data.text === 'string' ? data.text : ''
  }
  return ''
}
