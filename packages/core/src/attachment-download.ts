export const CONVEX_STORAGE_PATH = '/api/storage/'
export const ATTACHMENT_DOWNLOAD_PATH = '/api/attachment-download/'

const STORAGE_ID = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i

/** Extracts the UUID used in Convex's public file storage URLs. */
export function storageIdFromPath(path: string, prefix: string) {
  if (!path.startsWith(prefix)) return
  const id = path.slice(prefix.length)
  if (STORAGE_ID.test(id)) return id.toLowerCase()
}
