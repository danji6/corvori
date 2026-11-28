import type { LanguageModelV4Prompt } from '@ai-sdk/provider'
import { READ_FILE_TOOL_NAME } from '@cv/core/const'

type PromptMessage = LanguageModelV4Prompt[number]
type UserContent = Extract<PromptMessage, { role: 'user' }>['content']
type ToolContent = Extract<PromptMessage, { role: 'tool' }>['content'][number]

const TOOL_IMAGE_PROVIDERS = new Set([
  'anthropic.messages',
  'ollama',
  'openai.responses',
])

/** Some adapters stringify tool results but accept images in user messages. */
export function placeFileImagesInPrompt(
  prompt: LanguageModelV4Prompt,
  provider: string,
): LanguageModelV4Prompt {
  if (TOOL_IMAGE_PROVIDERS.has(provider)) return prompt

  const result: LanguageModelV4Prompt = []
  let images: UserContent = []
  for (const message of prompt) {
    if (message.role === 'tool') {
      result.push({
        ...message,
        content: message.content.map((part) => placeImage(part, images)),
      })
      continue
    }
    if (images.length) {
      result.push({ role: 'user', content: images })
      images = []
    }
    result.push(message)
  }
  if (images.length) result.push({ role: 'user', content: images })
  return result
}

function placeImage(part: ToolContent, images: UserContent): ToolContent {
  if (part.type !== 'tool-result' || part.toolName !== READ_FILE_TOOL_NAME)
    return part
  if (part.output.type !== 'content') return part
  const files = part.output.value.filter((item) => item.type === 'file')
  if (!files.length) return part

  const text = part.output.value
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n')
  images.push(
    { type: 'text', text: `Image from read_file result ${part.toolCallId}` },
    ...files,
  )
  return { ...part, output: { type: 'text', value: text } }
}
