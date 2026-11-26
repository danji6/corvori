/** Split a simple filename glob with a fixed directory prefix. */
export function splitShellFileGlob(value: string) {
  const slash = value.lastIndexOf('/') + 1
  const directory = value.slice(0, slash)
  const filename = value.slice(slash)
  if (!/^[^*]*\*[^*]*$/.test(filename) || directory.includes('*')) return null
  if (!/^[a-z0-9_./*+@% =,:-]+$/i.test(value)) return null
  return { directory, filename }
}
