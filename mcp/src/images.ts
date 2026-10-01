import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { basename } from 'node:path'

export interface ImageAttachment {
  id: string
  filename: string
  caption: string
  content_type: string
  byte_size: number
  width: number
  height: number
  created_at: string
  uploader_id: string
  uploader_name: string
  source: string
  content_url: string
  download_url: string
}

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

export function imageTarget(key?: string, milestoneId?: string): string {
  if (Boolean(key?.trim()) === Boolean(milestoneId?.trim())) {
    throw new Error('Provide exactly one key or milestone_id')
  }
  return key?.trim()
    ? `issues/${encodeURIComponent(key.trim().toUpperCase())}`
    : `milestones/${encodeURIComponent(milestoneId!.trim())}`
}

/** Read only the explicitly provided regular file, never follow a final symlink. */
export async function imageForm(path: string, caption: string): Promise<FormData> {
  if (!caption.trim()) throw new Error('caption is required and must describe relevance')
  const info = await lstat(path)
  if (!info.isFile()) throw new Error('image path must be a regular file, not a symlink or special file')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.dev !== info.dev || stat.ino !== info.ino) throw new Error('image file changed before reading')
    if (stat.size > MAX_IMAGE_BYTES) throw new Error('image exceeds 10 MiB limit')
    const bytes = Buffer.alloc(MAX_IMAGE_BYTES + 1)
    let length = 0
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, null)
      if (result.bytesRead === 0) break
      length += result.bytesRead
    }
    if (length > MAX_IMAGE_BYTES) throw new Error('image exceeds 10 MiB limit')
    if (length === 0) throw new Error('image file is empty')
    const form = new FormData()
    form.set('file', new Blob([new Uint8Array(bytes.subarray(0, length))]), basename(path))
    form.set('caption', caption.trim())
    return form
  } finally {
    await handle.close()
  }
}
