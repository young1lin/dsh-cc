/**
 * The tool row's stylesheet, kept beside the component that registers it.
 *
 * Only host tokens are used: the row must sit in a harness transcript without
 * introducing a colour, a font, or a radius the rest of the page does not
 * already have. The card classes carry two selectors so their `--dsl-*`
 * rebindings outrank the primitive's own single-class declaration of the same
 * property.
 *
 * @module dsh-cc/client/tool/tool-row-css
 */

/** The complete sheet for {@link module:dsh-cc/client/tool/ToolRow}. */
export const TOOL_ROW_CSS = `
.cc-tool { align-self: stretch; display: flex; flex-direction: column; }

/* Plan-mode exit's proposed plan, drawn as markdown inside the row body. */
.cc-plan {
  max-height: 320px;
  overflow-y: auto;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-base);
  font: var(--dsw-font-xs-13);
}

.cc-tool-row { position: relative; overflow: hidden; }

/* Running sweep: a fixed-width glare band at 60% of the page ground glides
   across the row, washing the glyphs toward the background as it passes. The
   10% end hold gives each pass a beat before the next. */
.cc-tool[data-state='running'] .cc-tool-row::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 300px;
  background: linear-gradient(
    90deg,
    transparent 0%,
    color-mix(in srgb, var(--dsw-alias-bg-base) 60%, transparent) 55%,
    transparent 100%
  );
  animation: cc-tool-row-sweep 2.6s ease-out infinite;
  pointer-events: none;
}

@keyframes cc-tool-row-sweep {
  0% { left: -300px; }
  90%, 100% { left: 100%; }
}

.cc-tool-lead { flex-shrink: 0; }
.cc-tool-chevron { color: var(--dsw-alias-label-secondary); }
.cc-tool-title { font: var(--dsw-font-s-14); font-weight: 400; color: var(--dsw-alias-label-primary); }

.cc-tool-sep {
  flex: none;
  width: 2px;
  height: 2px;
  margin: 0 8px;
  border-radius: 1px;
  background: var(--dsw-alias-label-caption);
}

.cc-tool-summary {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: var(--dsw-font-s-14);
  color: var(--dsw-alias-label-tertiary);
}

.cc-tool-summary[data-error='true'] { color: var(--dsw-alias-state-error-primary); }

/* Trailing fragment kept out of the summary's ellipsis — a diff's +/- counts or
   a plan's parallel-active count, whose whole value is surviving a narrow row.
   \`flex: none\` stops the box shrinking but not the text wrapping, so the
   nowrap is what keeps the row one line. */
.cc-tool-suffix {
  flex: none;
  margin-left: 6px;
  white-space: nowrap;
  font: var(--dsw-font-s-14);
  color: var(--dsw-alias-label-dimmed);
}

.cc-tool-body { display: flex; flex-direction: column; }

/* Every card body takes the row's own indent, replacing each primitive's
   standalone vertical spacing with the transcript's row rhythm. */
.cc-card { margin: 4px 0 4px 4px; }

/* The terminal card scrolls its OUTPUT inside its own surface, so the banner
   stays pinned and the scrollbar never rides over it; 224px is the 260px body
   cap minus the banner. The in-row code size pairs with a tighter line box. */
.cc-card.cc-card-terminal {
  --dsl-terminal-font: var(--dsw-font-markdown-code-block-small);
  --dsl-terminal-line-height: 18px;
  --dsl-terminal-output-max-height: 224px;
  border: 1px solid var(--dsw-alias-border-l1);
}

/* A tool's own note about a capped result, below the card that holds only the
   retained rows. */
.cc-note-line {
  margin: 4px 0 4px 4px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: var(--dsw-font-xs-13);
  color: var(--dsw-alias-label-tertiary);
}

/* Generic IN/OUT card: the code-block surface, with the padding and the
   gutter-label grid on each section so the divider spans the full width and
   each section scrolls alone. */
.cc-io {
  display: flex;
  flex-direction: column;
  margin: 4px 0 4px 4px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  background: var(--dsw-alias-markdown-code-block);
  font: var(--dsw-font-markdown-code-block-small);
  font-family: var(--ds-font-family-code);
}

.cc-io-section {
  display: grid;
  grid-template-columns: max-content 1fr;
  column-gap: 14px;
  align-items: baseline;
  max-height: 220px;
  padding: 10px 14px;
  overflow: auto;
}

.cc-io-label { position: sticky; top: 0; align-self: start; color: var(--dsw-alias-label-caption); }
.cc-io-divider { flex: none; height: 1px; background: var(--dsw-alias-border-l2); }

.cc-io-text {
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--dsw-alias-label-secondary);
}

.cc-io-text[data-error='true'] { color: var(--dsw-alias-state-error-primary); }
.cc-io-json { min-width: 0; }

/* Checklist: the plan panel's item rhythm, inside the row's card indent. */
.cc-todo {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 6px 0 6px 4px;
  padding: 0;
  list-style: none;
}

.cc-todo-item {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  font: var(--dsw-font-xs-13);
  color: var(--dsw-alias-label-secondary);
}

.cc-todo-glyph { display: grid; flex: none; place-items: center; width: 16px; height: 16px; }
.cc-todo-item[data-status='completed'] .cc-todo-glyph { color: var(--dsw-alias-state-success-primary); }
.cc-todo-item[data-status='pending'] .cc-todo-glyph { color: var(--dsw-alias-label-caption); }

.cc-todo-item[data-status='in_progress'] .cc-todo-glyph {
  color: var(--dsw-alias-state-business-primary);
  animation: cc-todo-spin 1s linear infinite;
}

@keyframes cc-todo-spin {
  to { transform: rotate(360deg); }
}

.cc-todo-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cc-todo-item[data-status='completed'] .cc-todo-label { color: var(--dsw-alias-label-dimmed); text-decoration: line-through; }
.cc-todo-item[data-status='in_progress'] .cc-todo-label { color: var(--dsw-alias-label-primary); font-weight: 500; }

/* Subagent report: prose at the transcript's own markdown size, set in from the
   row so it reads as this call's output rather than as the agent's own turn. */
.cc-task {
  max-height: 320px;
  margin: 4px 0 4px 4px;
  padding: 10px 14px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  overflow-y: auto;
  font: var(--dsw-font-xs-13);
  color: var(--dsw-alias-label-secondary);
}

.cc-task :where(p) { margin: 0.4em 0; }
.cc-task :where(h1, h2, h3, h4) { margin: 0.7em 0 0.3em; }
.cc-task :where(ul, ol) { margin: 0.4em 0; padding-left: 1.4em; }

/* Run-state text for assistive technology: the dot and the sweep are both
   aria-hidden or colour-only. */
.cc-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
`
