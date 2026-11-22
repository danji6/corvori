import { parseProviderExtraHeaders } from '@cv/core/provider-headers'
import {
  PROVIDER_PLACEHOLDERS,
  type ProviderPlaceholderName,
} from '@cv/core/provider-placeholders'

const TOKEN_PATTERN = /\{\{(\w+)\}\}/g

export type ProviderPlaceholderResolvers = Partial<
  Record<ProviderPlaceholderName, () => string | Promise<string>>
>
export type ResolveProviderPlaceholder = (
  name: ProviderPlaceholderName,
) => Promise<string> | undefined
export type ProviderPlaceholderValues = ReadonlyMap<string, string>

/** Shares lazy resolutions between configured extras and transport defaults. */
export function requestPlaceholderResolver(
  resolvers: ProviderPlaceholderResolvers = {},
): ResolveProviderPlaceholder {
  const values = new Map<ProviderPlaceholderName, Promise<string>>()
  return (name) => {
    if (!Object.hasOwn(resolvers, name)) return
    const resolve = resolvers[name]
    if (!resolve) return

    const cached = values.get(name)
    if (cached) return cached

    const value = Promise.resolve().then(resolve)
    values.set(name, value)
    return value
  }
}

export function findProviderPlaceholders(value: unknown) {
  const names = new Set<ProviderPlaceholderName>()
  collectPlaceholders(value, names)
  return names
}

function collectPlaceholders(
  value: unknown,
  names: Set<ProviderPlaceholderName>,
) {
  if (typeof value === 'string') {
    for (const [, name] of value.matchAll(TOKEN_PATTERN)) {
      if (isProviderPlaceholder(name)) names.add(name)
    }
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectPlaceholders(item, names)
  }
}

function isProviderPlaceholder(name: string): name is ProviderPlaceholderName {
  return Object.hasOwn(PROVIDER_PLACEHOLDERS, name)
}

export async function resolveProviderPlaceholders(
  names: ReadonlySet<ProviderPlaceholderName>,
  resolve: ResolveProviderPlaceholder,
): Promise<ProviderPlaceholderValues> {
  const values = new Map<ProviderPlaceholderName, string>()
  for (const name of names) {
    const value = resolve(name)
    if (!value) {
      throw new Error(
        `No resolver provided for provider placeholder {{${name}}}`,
      )
    }
    values.set(name, await value)
  }
  return values
}

export function expandProviderTemplate(
  value: string,
  values: ProviderPlaceholderValues,
) {
  return value.replace(TOKEN_PATTERN, (token, name: string) => {
    return values.get(name) ?? token
  })
}

export function expandProviderParameters(
  parameters: Record<string, unknown>,
  values: ProviderPlaceholderValues,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(parameters).map(([key, value]) => [
      key,
      expandParameterValue(value, values),
    ]),
  )
}

function expandParameterValue(
  value: unknown,
  values: ProviderPlaceholderValues,
): unknown {
  if (typeof value === 'string') return expandProviderTemplate(value, values)
  if (Array.isArray(value)) {
    return value.map((item) => expandParameterValue(item, values))
  }
  if (value && typeof value === 'object') {
    return expandProviderParameters(value as Record<string, unknown>, values)
  }
  return value
}

/** Keeps only static headers for requests without an inference context. */
export function discoveryExtraHeaders(value?: string) {
  return Object.fromEntries(
    Object.entries(parseProviderExtraHeaders(value)).filter(
      ([, header]) => findProviderPlaceholders(header).size === 0,
    ),
  )
}
