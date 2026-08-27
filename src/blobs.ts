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
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MEDIA_TYPE_EXTENSIONS, type ImageRef } from './types.ts'

/**
 * How long a blob is protected from the sweep regardless of who references
 * it. An image pasted into the composer is uploaded immediately but referenced
 * by nothing until the message is sent, and an unsent draft (which lives in
 * the browser's storage, where no host-side sweep can see it) may sit for
 * weeks. The window is generous on purpose: blobs are small, the sweep exists
 * to bound growth over years, and the cost of being wrong is a user's pasted
 * image turning into "图片已失效，请重新粘贴".
 */
const SWEEP_GRACE_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Whether a string names an image type this store accepts.
 * @param value - the candidate media type.
 * @returns true when the type is supported.
 */
export function isImageMediaType(value: string): value is ImageRef['mediaType'] {
  return value in MEDIA_TYPE_EXTENSIONS
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
   * Delete stored images nothing refers to any more.
   *
   * Content addressing keeps duplicates out but does nothing about growth:
   * without this the directory only ever grew, and deleting a session left its
   * images behind forever. A blob is dropped only when it is BOTH unreferenced
   * and older than {@link SWEEP_GRACE_MS} — see that constant for why the
   * grace period is not optional.
   *
   * Dropping a blob is recoverable in the common case: images that came from a
   * native transcript are re-stored under the same id the next time that
   * transcript is read, because the id is the content hash. Only an image that
   * exists solely in a page draft is unrecoverable, which is what the grace
   * period protects.
   *
   * @param referenced - every blob id the sidecar transcripts still mention.
   * @returns how many files were deleted and how many bytes they held.
   */
  async sweep(referenced: ReadonlySet<string>): Promise<{ deleted: number; bytes: number }> {
    let deleted = 0
    let bytes = 0
    let entries: string[]
    try {
      entries = await readdir(this.dir)
    } catch {
      // No blob directory yet, or it became unreadable: nothing to sweep.
      return { deleted, bytes }
    }
    const cutoff = Date.now() - SWEEP_GRACE_MS
    for (const entry of entries) {
      const id = entry.replace(/\.[^.]+$/, '')
      if (referenced.has(id)) continue
      const file = join(this.dir, entry)
      try {
        const info = await stat(file)
        if (info.mtimeMs >= cutoff) continue
        await rm(file, { force: true })
        deleted += 1
        bytes += info.size
      } catch {
        // Raced with a concurrent write, or locked by another process; the
        // next sweep gets it.
      }
    }
    return { deleted, bytes }
  }

  /**
   * The on-disk path of one blob.
   * @param id - the blob id.
   * @param mediaType - the image type, which selects the extension.
   * @returns the absolute file path.
   */
  private path(id: string, mediaType: ImageRef['mediaType']): string {
    return join(this.dir, `${id}.${MEDIA_TYPE_EXTENSIONS[mediaType]}`)
  }
}
