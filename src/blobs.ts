/**
 * Content-addressed storage for the image bytes attached to user messages.
 *
 * Images reach the store from two directions: pasted into the page, and read
 * back out of the CLI's own transcript, where they are inline base64. Both
 * land in the same place under the same id, because the id is the SHA-256 of
 * the bytes — so re-reading a native transcript re-derives the ids it derived
 * last time and writes nothing new.
 *
 * @module dsh-cc/blobs
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ImageRef } from './types.ts'

/** Image media types the page and the CLI exchange. */
const EXTENSIONS: Record<ImageRef['mediaType'], string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

/**
 * Whether a string names an image type this store accepts.
 * @param value - the candidate media type.
 * @returns true when the type is supported.
 */
export function isImageMediaType(value: string): value is ImageRef['mediaType'] {
  return value in EXTENSIONS
}

/** Image bytes on disk, addressed by content hash. */
export class BlobStore {
  private readonly dir: string

  /**
   * @param dataDir - the session store directory; blobs live in its `blobs/` child.
   */
  constructor(dataDir: string) {
    this.dir = join(dataDir, 'blobs')
    mkdirSync(this.dir, { recursive: true })
  }

  /**
   * Store one image, or recognise it as already stored.
   * @param bytes - the raw image bytes.
   * @param mediaType - the image type.
   * @param name - the original file name, when it came from a file.
   * @returns the reference to record on the transcript event.
   */
  async put(bytes: Buffer, mediaType: ImageRef['mediaType'], name?: string): Promise<ImageRef> {
    const id = createHash('sha256').update(bytes).digest('hex').slice(0, 32)
    const file = this.path(id, mediaType)
    // Content-addressed: identical bytes are already the same file, so a
    // second write would only rewrite what is there.
    if (!existsSync(file)) await writeFile(file, bytes)
    return {
      id,
      mediaType,
      ...(name !== undefined ? { name } : {}),
      bytes: bytes.length,
    }
  }

  /**
   * Read one stored image back.
   * @param id - the blob id.
   * @param mediaType - the type the id was stored under.
   * @returns the bytes, or undefined when the blob is absent.
   */
  async get(id: string, mediaType: ImageRef['mediaType']): Promise<Buffer | undefined> {
    const file = this.path(id, mediaType)
    if (!existsSync(file)) return undefined
    return await readFile(file)
  }

  /**
   * The on-disk path of one blob.
   * @param id - the blob id.
   * @param mediaType - the image type, which selects the extension.
   * @returns the absolute file path.
   */
  private path(id: string, mediaType: ImageRef['mediaType']): string {
    return join(this.dir, `${id}.${EXTENSIONS[mediaType]}`)
  }
}
