/**
 * The branch/worktree tag for the status strip: where this session's cwd
 * sits in git. The value is read live from git by the node half — the CLI
 * only persists a lagging end-of-session branch stamp, and knows no
 * worktree name — so it is correct for cold sessions and tracks checkouts
 * made mid-turn. Hidden entirely outside a repo.
 *
 * @module dsh-cc/client/status/BranchTag
 */

import type { ReactElement } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { GitInfo } from '../api/telemetry.ts'
import { registerCss } from '../css.ts'

registerCss('status-branch', `
.cc-branch-tag {
  display: inline-flex;
  align-items: center;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
`)

/**
 * Render the branch tag.
 * @param props.git - the session cwd's git readout; undefined (or a repo with
 *   neither a branch nor a sha to show) hides the tag.
 * @returns the tag node, or null.
 */
export function BranchTag(props: { git: GitInfo | undefined }): ReactElement | null {
  const { git } = props
  if (git === undefined) return null
  const detached = git.branch === ''
  const label = detached ? (git.detached ?? '') : git.branch
  if (label === '') return null
  // The full position — branch, worktree, root — only the tooltip carries;
  // the tag itself stays one pill wide.
  const tip = [
    detached ? `分离头指针 @${git.detached ?? ''}` : `分支 ${git.branch}`,
    git.worktree !== undefined && git.worktree !== '' ? `worktree ${git.worktree}` : '',
    git.root ?? '',
  ].filter(part => part !== '').join(' · ')
  return (
    <Tooltip label={tip} side="bottom">
      <span className="cc-branch-tag">{detached ? `@${label}` : label}</span>
    </Tooltip>
  )
}
