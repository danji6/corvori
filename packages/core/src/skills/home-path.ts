/** Identifies a managed home relative to the sidecar data directory. */
export function managedHomePath(ownerId: string, originAgentId: string) {
  return `agents/${ownerId}/${originAgentId}`
}
