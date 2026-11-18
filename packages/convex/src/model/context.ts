let tokenizer: ReturnType<typeof loadTokenizer> | undefined

function getTokenizer() {
  return (tokenizer ??= loadTokenizer())
}

async function loadTokenizer() {
  const [{ Tiktoken }, { default: cl100k_base }] = await Promise.all([
    import('js-tiktoken/lite'),
    import('js-tiktoken/ranks/cl100k_base'),
  ])
  const tokenizer = new Tiktoken(cl100k_base)
  return {
    encode(text: string) {
      return { length: tokenizer.encode(text, [], []).length }
    },
  }
}

export async function estimateTokens(text: string): Promise<number> {
  if (!text) return 0
  return (await getTokenizer()).encode(text).length
}
