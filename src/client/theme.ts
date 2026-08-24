/**
 * Shell styles for the Claude Code surface, written entirely against the host
 * design tokens (`--dsw-alias-*` / `--dsw-font-*`, defined on `body` by
 * dsh-client-ui-theme). The plugin defines no palette of its own, so light and
 * dark follow the host theme with nothing to keep in sync.
 *
 * This module owns the frame only — the launcher dock, the overlay layer, the
 * session rail, the header, the scroll region, and small shared atoms. Feature
 * modules register their own sheets through {@link registerCss}.
 *
 * @module dsh-cc/client/theme
 */

import { registerCss } from './css.ts'

registerCss('shell', `
/* The overlay sits inside the host frame's shell.overlay layer, which is
   absolutely positioned and click-through; an entry opts back into pointer
   events by being a real surface. */
.cc-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family);
  animation: cc-fade-in 140ms var(--ds-ease-in-out);
}

@keyframes cc-fade-in { from { opacity: 0; } to { opacity: 1; } }

/* ── session rail ─────────────────────────────────────────── */
.cc-rail {
  width: 240px;
  flex: none;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--dsw-alias-border-l2);
  /* The same fill the host sidebar uses, so the two rails read as one shell. */
  background: var(--dsw-specific-sidebar-fill);
}

.cc-rail-head { padding: 12px; }
.cc-rail-list { flex: 1; overflow-y: auto; padding: 0 8px 8px; }

/* A project group header, mirroring the host workspace browser's project row
   (ui-workspace Rows.module.css): 34px cell, folder glyph by default, expand
   chevron + row actions on hover, sticky so the directory stays visible while
   its sessions scroll under it (and above the positioned session rows). */
.cc-project-row {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 34px;
  box-sizing: border-box;
  border-radius: 8px;
  padding: 0 8px;
  cursor: pointer;
  user-select: none;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-specific-sidebar-fill);
}

.cc-project-row:hover { background: var(--dsw-alias-interactive-bg-hover); }

.cc-slot {
  flex: none;
  width: 16px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--dsw-alias-label-tertiary);
}

.cc-slot svg { display: block; }

/* The folder sits one step darker (tertiary) at rest and takes the business
   tint while it is the expanded group holding the current session. */
.cc-folder[data-active='true'] { color: var(--dsw-alias-state-business-primary); }

/* Leading slot swap: folder by default, chevron on row hover. */
.cc-project-row .cc-chevron { display: none; color: var(--dsw-alias-label-caption); }
.cc-project-row:hover .cc-chevron { display: inline-flex; }
.cc-project-row:hover .cc-folder { display: none; }

/* Expand triangle: points right closed, rotates to point down open. */
.cc-project-row .cc-chevron svg { transition: transform 150ms var(--ds-ease-in-out); }
.cc-project-row[aria-expanded='true'] .cc-chevron svg { transform: rotate(90deg); }

.cc-project-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.cc-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  line-height: 20px;
}

/* Trailing action buttons surface on hover only: bare 16px glyphs. */
.cc-row-actions {
  flex: none;
  display: none;
  align-items: center;
  gap: 12px;
  height: 20px;
}

.cc-project-row:hover .cc-row-actions { display: inline-flex; }

.cc-icon-button {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border: none;
  border-radius: 4px;
  padding: 0;
  background: transparent;
  cursor: pointer;
  color: var(--dsw-alias-label-tertiary);
}

.cc-icon-button:hover { color: var(--dsw-alias-label-primary); }

.cc-rail-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-top: 1px solid var(--dsw-alias-border-l2);
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-tertiary);
}

.cc-session {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  margin-bottom: 2px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-xs-13);
  text-align: left;
  cursor: pointer;
  transition: background var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}

.cc-session:hover { background: var(--dsw-alias-interactive-bg-hover); }

.cc-session[data-active='true'] {
  background: var(--dsw-alias-interactive-bg-active);
  color: var(--dsw-alias-label-primary);
}

.cc-session-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cc-session-time {
  flex: none;
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-caption);
}

/* Row actions stay hidden until the row is hovered or focused within, so a
   quiet list is not a wall of icons. */
.cc-session-action {
  flex: none;
  padding: 2px 4px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-caption);
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}

.cc-session:hover .cc-session-action,
.cc-session-action:focus-visible { opacity: 1; }
.cc-session-action:hover { background: var(--dsw-alias-interactive-bg-hover-solid); color: var(--dsw-alias-label-primary); }
.cc-session-action[data-danger='true']:hover { background: var(--dsw-alias-interactive-bg-hover-danger); color: var(--dsw-alias-state-error-primary); }

/* ── main column ──────────────────────────────────────────── */
.cc-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }

.cc-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
}

.cc-head-title { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.cc-head-title strong { font: var(--dsw-font-s-strong-14); }

.cc-head-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-tertiary);
}

.cc-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px 8px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.cc-composer { padding: 8px 24px 16px; }

/* ── shared atoms ─────────────────────────────────────────── */
.cc-empty {
  padding: 16px;
  text-align: center;
  font: var(--dsw-font-xs-13);
  color: var(--dsw-alias-label-tertiary);
}

.cc-center { margin: auto; }

.cc-error-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 20px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-state-error-secondary);
  color: var(--dsw-alias-state-error-primary);
  font: var(--dsw-font-xs-13);
}

.cc-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-secondary);
}

.cc-field select {
  padding: 6px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font: var(--dsw-font-xs-13);
  outline: none;
}

.cc-field select:focus { border-color: var(--dsw-alias-brand-primary); }

.cc-row { display: flex; align-items: center; gap: 8px; }
.cc-spacer { flex: 1; }

.cc-mono {
  font: var(--dsw-font-markdown-code-block-small);
  font-family: var(--ds-font-family-code);
}

/* ── launcher dock ────────────────────────────────────────── */
.cc-dock {
  position: absolute;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 14px 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-right: none;
  border-radius: 12px 0 0 12px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-xxs-12);
  cursor: pointer;
  box-shadow: var(--dsw-shadow-lv1);
  transition: background var(--ds-transition-duration) var(--ds-ease-in-out),
              color var(--ds-transition-duration) var(--ds-ease-in-out);
}

.cc-dock:hover {
  background: var(--dsw-alias-interactive-bg-hover-solid);
  color: var(--dsw-alias-label-primary);
}

.cc-dock-label {
  writing-mode: vertical-rl;
  letter-spacing: 2px;
  white-space: nowrap;
  user-select: none;
}

/* ── scrollbars ───────────────────────────────────────────── */
.cc-scroll::-webkit-scrollbar,
.cc-rail-list::-webkit-scrollbar { width: 8px; height: 8px; }

.cc-scroll::-webkit-scrollbar-thumb,
.cc-rail-list::-webkit-scrollbar-thumb {
  border: 2px solid transparent;
  border-radius: 6px;
  background: var(--dsw-alias-scrollbar-bg-l1);
  background-clip: padding-box;
}

.cc-scroll::-webkit-scrollbar-thumb:hover,
.cc-rail-list::-webkit-scrollbar-thumb:hover {
  background: var(--dsw-alias-scrollbar-hover-l1);
  background-clip: padding-box;
}

.cc-scroll::-webkit-scrollbar-track,
.cc-rail-list::-webkit-scrollbar-track { background: transparent; }

@media (prefers-reduced-motion: reduce) {
  .cc-overlay { animation: none; }
  .cc-dock, .cc-session, .cc-session-action, .cc-project-row .cc-chevron svg { transition: none; }
}
`)
