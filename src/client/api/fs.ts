/**
 * Filesystem read endpoints for the page: the file viewer's content read.
 *
 * @module dsh-cc/client/api/fs
 */

import { api } from './http.ts'

/** One text file as the viewer renders it. */
export interface FileContentDto {
  path: string
  content: string
  /** True when only the head of an oversized file was read. */
  truncated: boolean
}

/**
 * GET /fs/file?path= — the file's latest content, read from disk at request
 * time rather than from the transcript, so the view shows what is there now.
 * @param path - absolute file path.
 * @returns the content descriptor.
 */
export function fetchFile(path: string): Promise<{ file: FileContentDto }> {
  return api<{ file: FileContentDto }>(`/fs/file?path=${encodeURIComponent(path)}`)
}
