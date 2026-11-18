switch (process.argv[2]) {
  case 'sidebar':
    await (await import('./sidebar')).runSidebar()
    break
  case 'checkpoints':
    await (await import('./checkpoints')).runCheckpoints()
    break
  case 'shared-sends':
    await (await import('./sharedSends')).runSharedSends()
    break
  case 'tool-turns':
    await (await import('./toolTurns')).runToolTurns()
    break
  case 'active-streaming':
    await (await import('./activeStreaming')).runActiveStreaming()
    break
  case 'memory':
    await (await import('./memoryUsage')).runMemoryUsage()
    break
  default:
    throw new Error(
      'Usage: bun run test:perf <sidebar|checkpoints|shared-sends|tool-turns|active-streaming|memory>',
    )
}
