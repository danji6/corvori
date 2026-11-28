/** Restrict privileged invocations to literal words, without shell expansion or control operators. */
export function directShellWords(command: string): string[] | undefined {
  if (!command || /[^a-zA-Z0-9_.,@%+=:/ \t-]/.test(command)) return
  const words = command.trim().split(/[ \t]+/)
  return words[0] ? words : undefined
}

/** Only built-in noninteractive GitHub queries may receive the account credential. */
export function directGitHubQuery(command: string) {
  const words = directShellWords(command)
  if (!words || words[0] !== 'gh') return
  if (!['pr', 'issue'].includes(words[1]) || words[2] !== 'list') return
  return words
}

export function hasGitHubQueryGrant(command: string, grants: string[] = []) {
  const words = directGitHubQuery(command)
  return (
    !!words &&
    grants.some((grant) => {
      const prefix = directShellWords(grant)
      return prefix?.length && prefix.every((word, i) => words[i] === word)
    })
  )
}
