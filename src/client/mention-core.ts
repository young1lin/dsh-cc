/**
 * Pure @-mention menu logic: caret-local '@' token detection, fuzzy path
 * ranking, absolute-path navigation, and insertion planning. Framework-free
 * on purpose — the grammar and the pick math stay checkable without a DOM.
 * The menu semantics follow the host's ui-file-reference design: the '@'
 * gesture searches a project-wide index (never a one-directory browser), an
 * absolute query navigates the live filesystem, and a pick replaces the
 * whole half-typed token run.
 *
 * @module dsh-cc/client/mention-core
 */

import type { FileIndexRow } from '../types.ts'

/** A menu row is an index row: a workspace-relative (or absolute) POSIX path. */
export type MenuRow = FileIndexRow

/**
 * A ranked row carrying where the query matched it, so the roster can
 * highlight the matched characters. Ranking order is untouched — the
 * positions ride along on data the ranker already computed.
 */
export interface RankedRow extends MenuRow {
  /**
   * Ascending indices into `path` of the matched characters; absent when the
   * row was not ranked against a query (bare '@', the absolute-reference row).
   */
  readonly matched?: readonly number[]
}

/** Rendered-row cap; the viewport scrolls beyond it. */
export const MAX_MENU_ROWS = 50

/** Keyboard paging step for PageUp/PageDown in the menu. */
export const PAGE_ROWS = 10

/** The '@' token under the caret: where it starts and what is typed so far. */
export interface ReferenceToken {
  /** Offset of the '@' itself. */
  readonly start: number
  /** Non-whitespace run between the '@' and the caret; may be empty. */
  readonly query: string
}

/**
 * Detect the '@path' token being typed at the caret. Grammar mirrors the
 * send-time injection: the '@' must sit at the draft's start or after
 * whitespace (emails and handles never open the menu), and a doubled '@'
 * ('@@') is prose, not a reference. Unlike the injection the query may be
 * empty — the menu opens on the bare '@' and the pick completes it.
 * @param draft - the current input text.
 * @param caret - the caret offset within the draft.
 * @returns the token under the caret, or null when none.
 */
export function tokenAtCaret(draft: string, caret: number): ReferenceToken | null {
  const before = draft.slice(0, caret)
  const match = /@(\S*)$/.exec(before)
  if (match === null) return null
  const query = match[1] ?? ''
  if (query.startsWith('@')) return null
  const start = match.index
  if (start > 0 && !/\s/.test(before[start - 1] ?? '')) return null
  return { start, query }
}

/**
 * Insertion plan for one pick: the next draft and where the caret lands.
 * The reference run extends forward to the next whitespace, so a pick with
 * the caret inside a half-typed token replaces the whole run rather than
 * splicing inside it. The closing space terminates the reference token;
 * when the replaced run already ends at whitespace that character closes
 * it, so the insert adds no second space.
 * @param draft - the current input text.
 * @param token - the token being completed.
 * @param caret - the caret offset the token was detected at.
 * @param row - the picked candidate.
 * @returns the next draft and the post-insertion caret offset.
 */
export function insertionFor(
  draft: string,
  token: ReferenceToken,
  caret: number,
  row: MenuRow,
): { readonly next: string; readonly caret: number } {
  let end = caret
  while (end < draft.length && !/\s/.test(draft[end] ?? '')) end += 1
  const reference = `@${row.path}${row.directory === true ? '/' : ''}${end < draft.length ? '' : ' '}`
  return {
    next: draft.slice(0, token.start) + reference + draft.slice(end),
    caret: token.start + reference.length,
  }
}

/**
 * Whether a query spells an absolute path the user is typing deliberately:
 * drive-qualified (D:/ or D:\), UNC (\\server), or POSIX-rooted. A bare
 * drive letter with colon but no separator (D:) is drive-relative, not
 * absolute, and does not qualify.
 * @param query - the typed token body.
 * @returns true when the query spells an absolute path.
 */
export function isAbsoluteQuery(query: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(query)
}

/**
 * The synthetic menu row for an absolute-path query: the reference is the
 * typed path itself (the sender resolves it outright), a trailing separator
 * making it a folder reference.
 * @param query - the typed token body.
 * @returns the row, or null when the query is not absolute-shaped.
 */
export function absoluteReferenceRow(query: string): MenuRow | null {
  if (!isAbsoluteQuery(query)) return null
  const trailing = /[\\/]$/.test(query)
  // Canonical forward-slash spelling: the sender folds either separator,
  // and the row (and the insert it produces) stays visually consistent.
  const path = (trailing ? query.slice(0, -1) : query).replaceAll('\\', '/')
  return { path, ...trailing ? { directory: true } : {} }
}

/** The directory an absolute query navigates, plus the basename fragment still being typed. */
export interface AbsoluteDirTarget {
  /** Canonical forward-slash absolute directory to list (no trailing separator, except a bare root). */
  readonly dir: string
  /** The fragment after the last separator; '' when the query ends at one. */
  readonly fragment: string
}

/**
 * Resolve the directory an absolute-path query navigates: everything up to
 * the last separator, with whatever follows as the fragment. `@D:\dev\`
 * lists `D:/dev`; `@D:\dev\re` lists `D:/dev` for fragment `re`. A bare
 * root stays whole (`@D:\` lists `D:/`, `@/` lists `/`) — stripping its
 * separator would leave the drive-relative `D:` — and a non-absolute
 * query resolves to null (the project index owns those).
 * @param query - the typed token body.
 * @returns the directory to list and the fragment still being typed, or null for a non-absolute query.
 */
export function absoluteDirTarget(query: string): AbsoluteDirTarget | null {
  if (!isAbsoluteQuery(query)) return null
  const slashed = query.replaceAll('\\', '/')
  if (slashed.endsWith('/')) {
    const trimmed = slashed.slice(0, -1)
    const dir = trimmed === '' || /^[A-Za-z]:\/$/.test(slashed) ? slashed : trimmed
    return { dir, fragment: '' }
  }
  const cut = slashed.lastIndexOf('/')
  if (cut === 0) return { dir: '/', fragment: slashed.slice(1) }
  // A separator directly after the drive colon roots at the drive itself
  // (`D:/x` lists `D:/`); stripping it would leave the drive-relative `D:`.
  const dir = slashed[cut - 1] === ':' ? slashed.slice(0, cut + 1) : slashed.slice(0, cut)
  return { dir, fragment: slashed.slice(cut + 1) }
}

/** One fuzzy match: the subsequence hit's score and the matched character positions. */
export interface FuzzyHit {
  /** Higher is better; same-scale across subjects for one query. */
  readonly score: number
  /** Ascending subject indices of the matched characters. */
  readonly positions: readonly number[]
}

/**
 * Case-insensitive subsequence match of `query` inside `subject`, scored so
 * the natural picks win: boundary starts (string head, after `/`) and
 * contiguous runs score highest, basename hits outrank directory hits, and
 * tight spans outrank stretched ones. Greedy right-to-left alignment biases
 * toward suffix matches, where file names live.
 * @param subject - the path (or name) to match against.
 * @param query - the typed token body.
 * @returns the hit, or null when the query is not a subsequence.
 */
export function fuzzyMatch(subject: string, query: string): FuzzyHit | null {
  if (query === '') return null
  const hay = subject.toLowerCase()
  const needle = query.toLowerCase()
  const positions: number[] = []
  let at = hay.length
  // Right-to-left greedy: each needle character takes the latest subject
  // position that keeps the remaining suffix matchable.
  for (let i = needle.length - 1; i >= 0; i -= 1) {
    at = hay.lastIndexOf(needle[i] ?? '', at - 1)
    if (at < 0) return null
    positions.unshift(at)
  }
  const lastSlash = subject.lastIndexOf('/')
  let score = 0
  for (let i = 0; i < positions.length; i += 1) {
    const position = positions[i] ?? 0
    if (position === 0 || subject[position - 1] === '/') score += 8
    if (i > 0 && position === (positions[i - 1] ?? 0) + 1) score += 6
    if (position > lastSlash) score += 4
  }
  score -= (positions[positions.length - 1] ?? 0) - (positions[0] ?? 0) + 1 - needle.length
  return { score, positions }
}

/** Basename of a forward-slash path. */
const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/** Whether a row's basename is a dot-name (`.gitignore`, `.vite`). */
const isDotName = (row: MenuRow): boolean => baseName(row.path).startsWith('.')

/**
 * Listing order for a bare roster: dot-names sink below regular names —
 * they are maintenance files, never the first screen a bare '@' should
 * open with — then plain lexicographic, matching the walk's own sort.
 */
const byListingOrder = (a: MenuRow, b: MenuRow): number =>
  Number(isDotName(a)) - Number(isDotName(b))
  || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)

/**
 * Rank a directory listing against the typed basename fragment. Matching is
 * the same fuzzy subsequence as the index (`ev` finds `dev`), taken over
 * the child's own name — never the absolute prefix, or every child of
 * `D:/dev` would match a `de` fragment through the directory itself.
 * Basename prefixes rank first, then fuzzy scores; nothing matching keeps
 * the whole listing rather than blanking the navigation. An empty fragment
 * keeps the listing order (dot-names last).
 * @param entries - the directory listing's child rows.
 * @param fragment - the basename fragment typed after the last separator.
 * @returns the children in pick order, each ranked row carrying where the
 *   fragment matched its full path.
 */
export function rankDirChildren(entries: readonly MenuRow[], fragment: string): readonly RankedRow[] {
  const ordered = [...entries].sort(byListingOrder)
  if (fragment === '') return ordered
  const scored: { readonly row: MenuRow; readonly tier: number; readonly score: number; readonly hit: FuzzyHit }[] = []
  for (const row of entries) {
    const base = baseName(row.path)
    const hit = fuzzyMatch(base, fragment)
    if (hit === null) continue
    const tier = base.toLowerCase() === fragment.toLowerCase() ? 0 : base.toLowerCase().startsWith(fragment.toLowerCase()) ? 1 : 2
    scored.push({ row, tier, score: hit.score, hit })
  }
  if (scored.length === 0) return ordered
  return scored
    .sort((a, b) => a.tier - b.tier || b.score - a.score || (a.row.path < b.row.path ? -1 : a.row.path > b.row.path ? 1 : 0))
    .map(entry => {
      // The fragment matched the child's own name; shift those indices past
      // the directory prefix so they point into the row's full path.
      const offset = entry.row.path.length - baseName(entry.row.path).length
      return { ...entry.row, matched: entry.hit.positions.map(at => at + offset) }
    })
}

/** How the query relates to a row's basename; lower tiers rank higher. */
const tierOf = (row: MenuRow, query: string): number => {
  const base = baseName(row.path).toLowerCase()
  if (base === query) return 0
  if (base.startsWith(query)) return 1
  if (base.includes(query)) return 2
  return 3
}

/**
 * Match one row against the query for ranking and highlighting: null when
 * the row does not match at all. The tier captures the basename relation
 * (exact, prefix, contiguous, subsequence-only) so an ordinary prefix hit
 * always outranks a clever stretch.
 * @param row - the candidate row.
 * @param query - the typed token body (lowercased inside).
 * @returns the tier and fuzzy hit, or null when unmatched.
 */
export function matchRow(row: MenuRow, query: string): { readonly tier: number; readonly hit: FuzzyHit } | null {
  const hit = fuzzyMatch(row.path, query)
  if (hit === null) return null
  return { tier: tierOf(row, query.toLowerCase()), hit }
}

/**
 * Filter and rank index rows for a query. Matching is a fuzzy subsequence
 * over the path (`ev` finds `dev`, `dc` finds `dev-config`); ranking puts
 * basename-exact rows first, then basename prefixes, then contiguous
 * basename hits, then subsequence-only stretches, with the fuzzy score,
 * dot-name demotion, and the shorter path breaking ties. An empty query
 * keeps the listing order (dot-names last).
 * @param rows - the session's settled index.
 * @param query - the typed token body.
 * @param limit - rendered-row cap.
 * @returns the ranked, capped roster, each row carrying where the query
 *   matched it for the roster's highlight.
 */
export function filterRows(
  rows: readonly MenuRow[],
  query: string,
  limit: number = MAX_MENU_ROWS,
): readonly RankedRow[] {
  if (query === '') {
    return [...rows].sort(byListingOrder).slice(0, limit)
  }
  const scored: { readonly row: MenuRow; readonly tier: number; readonly score: number; readonly hit: FuzzyHit }[] = []
  for (const row of rows) {
    const matched = matchRow(row, query)
    if (matched !== null) scored.push({ row, tier: matched.tier, score: matched.hit.score, hit: matched.hit })
  }
  scored.sort((a, b) =>
    a.tier - b.tier
    || b.score - a.score
    || (Number(isDotName(a.row)) - Number(isDotName(b.row)))
    || a.row.path.length - b.row.path.length
    || (a.row.path < b.row.path ? -1 : a.row.path > b.row.path ? 1 : 0))
  return scored.map(entry => ({ ...entry.row, matched: entry.hit.positions })).slice(0, limit)
}

/**
 * Trailing description for a file row: the upper-cased extension when it is
 * short and meaningful; empty otherwise (folders label themselves).
 * @param path - the row's full path.
 * @returns the label, or '' when the name carries no usable extension.
 */
export function metaLabel(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return ''
  const ext = base.slice(dot + 1)
  return ext.length > 0 && ext.length <= 5 ? ext.toUpperCase() : ''
}
