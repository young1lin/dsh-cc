/**
 * Plugin styles: one stylesheet injected once per document. Design tokens
 * drive both themes; dark follows the host shell (data-ds-dark-theme) and
 * the system preference. Every class is cc-prefixed to stay clear of the
 * host GUI. Motion: 160ms transform/opacity only, honoring reduced-motion.
 *
 * @module dsh-cc/client/styles
 */

/** The complete overlay stylesheet; injected into the light DOM once. */
export const CSS = `
:root {
  --cc-accent: #4f6ef7;
  --cc-accent-strong: #3b5bf0;
  --cc-accent-soft: rgba(79, 110, 247, 0.12);
  --cc-danger: #e5484d;
  --cc-danger-soft: rgba(229, 72, 77, 0.1);
  --cc-warn: #f5a623;
  --cc-ok: #30a46c;
  --cc-bg: #ffffff;
  --cc-bg-soft: #f7f8fa;
  --cc-bg-inset: #f1f2f6;
  --cc-panel: #ffffff;
  --cc-code-bg: #16181d;
  --cc-code-fg: #e6e8ee;
  --cc-text: #1c2024;
  --cc-text-2: #5c6270;
  --cc-text-3: #9298a4;
  --cc-border: #e6e8ec;
  --cc-border-soft: #eef0f3;
  --cc-shadow-lg: 0 24px 80px rgba(9, 12, 24, 0.28), 0 4px 16px rgba(9, 12, 24, 0.1);
  --cc-shadow-md: 0 8px 28px rgba(9, 12, 24, 0.14);
  --cc-shadow-sm: 0 1px 3px rgba(9, 12, 24, 0.08);
  --cc-radius-lg: 14px;
  --cc-radius-md: 10px;
  --cc-radius-sm: 8px;
  --cc-ease: cubic-bezier(0.25, 0.8, 0.35, 1);
}
body[data-ds-dark-theme] .cc-overlay, body[data-ds-dark-theme] .cc-dock {
  --cc-accent: #6e86ff;
  --cc-accent-strong: #8195ff;
  --cc-accent-soft: rgba(110, 134, 255, 0.16);
  --cc-danger: #ff6369;
  --cc-danger-soft: rgba(255, 99, 105, 0.14);
  --cc-ok: #3dd68c;
  --cc-bg: #17191f;
  --cc-bg-soft: #1d2027;
  --cc-bg-inset: #23262e;
  --cc-panel: #1d2027;
  --cc-code-bg: #101216;
  --cc-code-fg: #dfe2ea;
  --cc-text: #eceef2;
  --cc-text-2: #a6acba;
  --cc-text-3: #6b7180;
  --cc-border: #2c3039;
  --cc-border-soft: #23262e;
  --cc-shadow-lg: 0 24px 80px rgba(0, 0, 0, 0.55), 0 4px 16px rgba(0, 0, 0, 0.35);
  --cc-shadow-md: 0 8px 28px rgba(0, 0, 0, 0.4);
  --cc-shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.35);
}

.cc-overlay {
  position: fixed; inset: 0; z-index: 10000;
  background: rgba(9, 12, 24, 0.4);
  backdrop-filter: blur(4px);
  animation: cc-fade-in 160ms var(--cc-ease);
}
@keyframes cc-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes cc-pop-in { from { opacity: 0; transform: translateY(8px) scale(0.99); } to { opacity: 1; transform: none; } }

.cc-app {
  position: absolute; inset: 22px;
  background: var(--cc-bg); color: var(--cc-text);
  border: 1px solid var(--cc-border-soft); border-radius: var(--cc-radius-lg);
  box-shadow: var(--cc-shadow-lg);
  display: flex; overflow: hidden;
  font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 13px; line-height: 1.65; text-align: left;
  animation: cc-pop-in 200ms var(--cc-ease);
}

/* ── sidebar ─────────────────────────────────────────────── */
.cc-side {
  width: 248px; flex: none;
  border-right: 1px solid var(--cc-border-soft);
  background: var(--cc-bg-soft);
  display: flex; flex-direction: column;
}
.cc-side-head { padding: 12px; border-bottom: 1px solid var(--cc-border-soft); }
.cc-side-foot {
  padding: 10px 14px; border-top: 1px solid var(--cc-border-soft);
  display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--cc-text-3);
}
.cc-spacer { flex: 1; }
.cc-session-list { flex: 1; overflow-y: auto; padding: 8px; }
.cc-session-row {
  position: relative;
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; margin-bottom: 2px;
  border-radius: var(--cc-radius-sm); cursor: pointer; border: none;
  background: transparent; width: 100%; text-align: left; font: inherit; color: var(--cc-text-2);
  transition: background 120ms, color 120ms;
}
.cc-session-row:hover { background: var(--cc-bg-inset); color: var(--cc-text); }
.cc-session-row-active { background: var(--cc-accent-soft); color: var(--cc-text); }
.cc-session-row-active::before {
  content: ""; position: absolute; left: 0; top: 20%; bottom: 20%;
  width: 3px; border-radius: 2px; background: var(--cc-accent);
}
.cc-session-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.cc-session-del {
  border: none; background: transparent; color: var(--cc-text-3); cursor: pointer;
  font-size: 14px; padding: 0 4px; border-radius: 6px; line-height: 1; opacity: 0;
  transition: opacity 120ms, color 120ms, background 120ms;
}
.cc-session-row:hover .cc-session-del { opacity: 1; }
.cc-session-del:hover { color: var(--cc-danger); background: var(--cc-danger-soft); }

.cc-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.cc-dot-idle { background: var(--cc-ok); }
.cc-dot-busy { background: var(--cc-warn); animation: cc-pulse 1.2s ease-in-out infinite; }
.cc-dot-error { background: var(--cc-danger); }
.cc-dot-ok { background: var(--cc-ok); }
.cc-dot-bad { background: var(--cc-text-3); }
@keyframes cc-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }

/* ── main column ─────────────────────────────────────────── */
.cc-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.cc-head {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 18px; border-bottom: 1px solid var(--cc-border-soft);
  background: var(--cc-panel);
}
.cc-head-title { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.cc-head-title strong { font-size: 14px; }
.cc-head-meta {
  font-size: 12px; color: var(--cc-text-3);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.cc-scroll {
  flex: 1; overflow-y: auto; padding: 22px 26px;
  display: flex; flex-direction: column; gap: 14px;
  scroll-behavior: smooth;
}

/* ── messages ────────────────────────────────────────────── */
/* Document flow: the assistant owns the full width; only the user bubble is inset. */
.cc-msg { border-radius: var(--cc-radius-md); }
.cc-msg-user {
  align-self: flex-end; max-width: 78%;
  background: linear-gradient(135deg, var(--cc-accent), var(--cc-accent-strong));
  color: #fff; border: none; border-bottom-right-radius: 4px;
  white-space: pre-wrap; word-break: break-word;
  padding: 9px 14px;
  box-shadow: var(--cc-shadow-sm);
}
.cc-msg-assistant {
  align-self: stretch; max-width: none; width: 100%;
  background: transparent; border: none; padding: 0;
}
body[data-ds-dark-theme] .cc-msg-assistant { background: transparent; }
.cc-msg-assistant :where(p) { margin: 0.4em 0; }
.cc-msg-assistant :where(pre) { margin: 0.5em 0; }
.cc-msg-assistant :where(h1, h2, h3, h4) { margin: 0.6em 0 0.3em; }
.cc-msg-assistant :where(ul, ol) { margin: 0.4em 0; padding-left: 1.4em; }
.cc-msg-assistant :where(table) { margin: 0.5em 0; border-collapse: collapse; }
.cc-msg-assistant :where(th, td) { border: 1px solid var(--cc-border); padding: 4px 10px; }
.cc-msg-assistant :where(blockquote) {
  margin: 0.5em 0; padding: 2px 12px; color: var(--cc-text-2);
  border-left: 3px solid var(--cc-border);
}
.cc-msg-thinking { align-self: flex-start; color: var(--cc-text-3); font-style: italic; font-size: 12px; }
.cc-msg-thinking summary { cursor: pointer; user-select: none; }
.cc-msg-system {
  align-self: center; color: var(--cc-text-3); font-size: 11.5px;
  background: var(--cc-bg-soft); border-radius: 999px; padding: 3px 14px;
}
.cc-msg-error {
  align-self: stretch; color: var(--cc-danger); background: var(--cc-danger-soft);
  border: 1px solid color-mix(in srgb, var(--cc-danger) 30%, transparent);
  border-radius: var(--cc-radius-sm); padding: 8px 14px; font-size: 12.5px;
}
.cc-msg-result { align-self: center; color: var(--cc-text-3); font-size: 11.5px; }
.cc-msg-result-error { color: var(--cc-danger); }
.cc-text { white-space: pre-wrap; word-break: break-word; }
.cc-pre {
  background: var(--cc-code-bg); color: var(--cc-code-fg);
  border-radius: var(--cc-radius-sm); border: 1px solid rgba(255, 255, 255, 0.06);
  padding: 11px 13px; overflow-x: auto; margin: 6px 0 2px;
  font-size: 12px; line-height: 1.55; font-family: "Cascadia Code", Consolas, monospace;
}

/* ── tool cards ──────────────────────────────────────────── */
.cc-details {
  align-self: stretch; width: 100%;
  border: 1px solid var(--cc-border); border-radius: var(--cc-radius-md);
  background: var(--cc-panel); box-shadow: var(--cc-shadow-sm);
  transition: border-color 120ms, box-shadow 120ms;
}
.cc-details:hover { border-color: color-mix(in srgb, var(--cc-accent) 40%, var(--cc-border)); }
.cc-details[open] { box-shadow: var(--cc-shadow-md); }
.cc-details summary {
  cursor: pointer; padding: 8px 13px; font-size: 12px; font-weight: 500;
  color: var(--cc-text-2); user-select: none; list-style: none;
  display: flex; align-items: center; gap: 6px;
}
.cc-details summary::before {
  content: ""; width: 0; height: 0; flex: none;
  border-left: 5px solid var(--cc-text-3); border-top: 4px solid transparent; border-bottom: 4px solid transparent;
  transition: transform 120ms var(--cc-ease);
}
.cc-details[open] summary::before { transform: rotate(90deg); }
.cc-details-body { padding: 2px 13px 11px; }
.cc-json {
  background: var(--cc-bg-inset); color: var(--cc-text-2);
  border-radius: var(--cc-radius-sm); padding: 9px 11px; overflow-x: auto;
  font-size: 11.5px; font-family: "Cascadia Code", Consolas, monospace;
  white-space: pre-wrap; word-break: break-all;
}
.cc-tool-error { border-color: color-mix(in srgb, var(--cc-danger) 45%, transparent); }
.cc-tool-error summary { color: var(--cc-danger); }

/* ── permission & question cards ─────────────────────────── */
.cc-perm {
  align-self: stretch;
  border: 1px solid color-mix(in srgb, var(--cc-warn) 55%, transparent);
  background: color-mix(in srgb, var(--cc-warn) 7%, var(--cc-panel));
  border-radius: var(--cc-radius-md); padding: 12px 14px;
  box-shadow: var(--cc-shadow-sm);
  animation: cc-pop-in 180ms var(--cc-ease);
}
.cc-perm-head { font-weight: 600; margin-bottom: 8px; }
.cc-perm-actions { display: flex; gap: 8px; margin-top: 10px; }

.cc-q-header { font-size: 11px; color: var(--cc-accent); font-weight: 600; margin-bottom: 2px; text-transform: uppercase; letter-spacing: 0.04em; }
.cc-q-text { font-size: 13.5px; color: var(--cc-text); margin-bottom: 8px; font-weight: 500; }
.cc-q-option {
  display: flex; flex-direction: column; gap: 2px; width: 100%; text-align: left;
  border: 1px solid var(--cc-border); border-radius: var(--cc-radius-sm);
  background: var(--cc-panel); padding: 8px 12px; cursor: pointer; font: inherit;
  margin-bottom: 5px; transition: border-color 120ms, background 120ms, transform 120ms;
}
.cc-q-option:hover { border-color: var(--cc-accent); transform: translateY(-1px); }
.cc-q-option-active {
  border-color: var(--cc-accent);
  background: var(--cc-accent-soft);
  box-shadow: inset 0 0 0 1px var(--cc-accent);
}
.cc-q-label { font-size: 12.5px; font-weight: 600; color: var(--cc-text); }
.cc-q-desc { font-size: 11.5px; color: var(--cc-text-2); }

/* ── composer ────────────────────────────────────────────── */
.cc-composer {
  border-top: 1px solid var(--cc-border-soft);
  padding: 12px 16px; display: flex; gap: 8px; align-items: flex-end;
  background: var(--cc-panel);
}
.cc-input {
  flex: 1; resize: none; min-height: 44px; max-height: 180px; outline: none;
  border: 1px solid var(--cc-border); border-radius: var(--cc-radius-md);
  background: var(--cc-bg); color: var(--cc-text);
  padding: 10px 14px; font: inherit;
  transition: border-color 120ms, box-shadow 120ms;
}
.cc-input:focus { border-color: var(--cc-accent); box-shadow: 0 0 0 3px var(--cc-accent-soft); }
.cc-input::placeholder { color: var(--cc-text-3); }

/* ── buttons ─────────────────────────────────────────────── */
.cc-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  border: 1px solid var(--cc-border); background: var(--cc-panel); color: var(--cc-text);
  border-radius: var(--cc-radius-sm); padding: 6px 14px; cursor: pointer; font: inherit;
  transition: background 120ms, border-color 120ms, transform 120ms, box-shadow 120ms;
}
.cc-btn:hover { background: var(--cc-bg-inset); border-color: var(--cc-text-3); }
.cc-btn:active { transform: scale(0.98); }
.cc-btn:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--cc-accent-soft); }
.cc-btn-primary {
  background: linear-gradient(135deg, var(--cc-accent), var(--cc-accent-strong));
  border: none; color: #fff; font-weight: 500;
  box-shadow: 0 2px 8px color-mix(in srgb, var(--cc-accent) 40%, transparent);
}
.cc-btn-primary:hover { filter: brightness(1.08); background: linear-gradient(135deg, var(--cc-accent), var(--cc-accent-strong)); }
.cc-btn-danger { color: var(--cc-danger); border-color: color-mix(in srgb, var(--cc-danger) 45%, transparent); }
.cc-btn-danger:hover { background: var(--cc-danger-soft); border-color: var(--cc-danger); }
.cc-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
.cc-link {
  border: none; background: transparent; color: var(--cc-accent); cursor: pointer;
  font: inherit; padding: 0;
}
.cc-link:hover { text-decoration: underline; }

/* ── forms & modals ──────────────────────────────────────── */
.cc-form {
  padding: 12px; border-bottom: 1px solid var(--cc-border-soft);
  display: flex; flex-direction: column; gap: 9px;
}
.cc-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--cc-text-2); }
.cc-field input, .cc-field select {
  border: 1px solid var(--cc-border); border-radius: var(--cc-radius-sm);
  background: var(--cc-bg); color: var(--cc-text); padding: 6px 10px;
  font: inherit; outline: none; transition: border-color 120ms, box-shadow 120ms;
}
.cc-field input:focus, .cc-field select:focus { border-color: var(--cc-accent); box-shadow: 0 0 0 3px var(--cc-accent-soft); }
.cc-empty { color: var(--cc-text-3); padding: 14px; text-align: center; }
.cc-center { margin: auto; }
.cc-error-bar {
  display: flex; align-items: center; gap: 8px;
  background: var(--cc-danger-soft); color: var(--cc-danger);
  border-bottom: 1px solid color-mix(in srgb, var(--cc-danger) 30%, transparent);
  padding: 7px 16px; font-size: 12.5px;
}
.cc-modal-backdrop {
  position: absolute; inset: 0; z-index: 20;
  background: rgba(9, 12, 24, 0.35); backdrop-filter: blur(2px);
  display: flex; align-items: center; justify-content: center;
  animation: cc-fade-in 140ms var(--cc-ease);
}
.cc-modal {
  background: var(--cc-panel); color: var(--cc-text);
  border: 1px solid var(--cc-border); border-radius: var(--cc-radius-lg);
  padding: 20px 22px; width: 540px; max-width: 92%; max-height: 84%; overflow-y: auto;
  box-shadow: var(--cc-shadow-lg);
  animation: cc-pop-in 180ms var(--cc-ease);
}
.cc-modal h3 { margin: 0 0 12px; font-size: 15px; }
.cc-kv { display: flex; gap: 10px; font-size: 12px; padding: 4px 0; }
.cc-kv-key { color: var(--cc-text-3); width: 130px; flex-shrink: 0; }
.cc-kv-val { word-break: break-all; color: var(--cc-text-2); }
.cc-hint {
  font-size: 12px; color: var(--cc-text-2); background: var(--cc-bg-soft);
  border: 1px solid var(--cc-border-soft);
  border-radius: var(--cc-radius-sm); padding: 10px 12px; margin-top: 12px;
  white-space: pre-wrap; font-family: "Cascadia Code", Consolas, monospace; font-size: 11.5px;
}

/* ── directory picker ────────────────────────────────────── */
.cc-picker { display: flex; flex-direction: column; min-height: 0; flex: 1; }
.cc-picker-bar { display: flex; gap: 8px; align-items: center; padding: 6px 0; }
.cc-picker-path {
  flex: 1; border: 1px solid var(--cc-border); border-radius: var(--cc-radius-sm);
  background: var(--cc-bg); color: var(--cc-text); padding: 6px 10px;
  font: inherit; font-size: 12px; outline: none;
}
.cc-picker-path:focus { border-color: var(--cc-accent); box-shadow: 0 0 0 3px var(--cc-accent-soft); }
.cc-picker-list {
  flex: 1; overflow-y: auto; border: 1px solid var(--cc-border);
  border-radius: var(--cc-radius-md); margin-top: 8px; background: var(--cc-bg);
}
.cc-picker-row {
  display: flex; align-items: center; gap: 8px; padding: 7px 12px; cursor: pointer;
  border: none; background: transparent; width: 100%; text-align: left;
  font: inherit; font-size: 13px; color: var(--cc-text-2);
  transition: background 100ms, color 100ms;
}
.cc-picker-row:hover { background: var(--cc-accent-soft); color: var(--cc-text); }
.cc-picker-row-file { color: var(--cc-text-3); cursor: default; }
.cc-picker-row-file:hover { background: transparent; color: var(--cc-text-3); }
.cc-picker-empty { padding: 18px; text-align: center; color: var(--cc-text-3); }

/* ── env editor rows ─────────────────────────────────────── */
.cc-env-row { display: flex; gap: 6px; align-items: center; }
.cc-env-key, .cc-env-val {
  border: 1px solid var(--cc-border); border-radius: var(--cc-radius-sm);
  background: var(--cc-bg); color: var(--cc-text);
  padding: 6px 10px; font: inherit; font-size: 12px;
  font-family: "Cascadia Code", Consolas, monospace; outline: none;
  transition: border-color 120ms, box-shadow 120ms;
}
.cc-env-key:focus, .cc-env-val:focus { border-color: var(--cc-accent); box-shadow: 0 0 0 3px var(--cc-accent-soft); }
.cc-env-key { width: 40%; flex: none; }
.cc-env-val { flex: 1; }
.cc-env-del {
  border: none; background: transparent; color: var(--cc-text-3); cursor: pointer;
  font-size: 14px; padding: 2px 6px; border-radius: 6px; transition: color 120ms, background 120ms;
}
.cc-env-del:hover { color: var(--cc-danger); background: var(--cc-danger-soft); }
.cc-section-title { font-size: 12px; font-weight: 600; color: var(--cc-text-2); margin: 12px 0 5px; }

/* ── status bar & usage ──────────────────────────────────── */
.cc-status-bar {
  display: flex; gap: 12px; align-items: center; padding: 5px 18px;
  font-size: 12px; color: var(--cc-text-2);
  border-bottom: 1px solid var(--cc-border-soft);
  background: var(--cc-bg-soft); flex-wrap: wrap;
}
.cc-status-select {
  border: 1px solid var(--cc-border); border-radius: 7px;
  background: var(--cc-panel); color: var(--cc-text);
  font: inherit; font-size: 12px; padding: 2px 7px; outline: none; max-width: 210px;
  transition: border-color 120ms;
}
.cc-status-select:hover { border-color: var(--cc-accent); }
.cc-status-select:focus { border-color: var(--cc-accent); box-shadow: 0 0 0 3px var(--cc-accent-soft); }
.cc-ctx-meter { font-family: "Cascadia Code", Consolas, monospace; font-size: 11px; color: var(--cc-text-2); white-space: nowrap; }
.cc-ctx-bar { letter-spacing: -1px; margin-right: 3px; color: var(--cc-accent); }
.cc-usage-bar {
  display: flex; gap: 14px; align-items: center;
  padding: 4px 18px; font-size: 12px; color: var(--cc-text-2);
  border-bottom: 1px solid var(--cc-border-soft); background: var(--cc-bg-soft);
}
.cc-usage-bar strong { color: var(--cc-text); }
.cc-usage-inline { display: inline-flex; gap: 12px; align-items: center; margin-left: auto; }
.cc-usage-tag {
  border: 1px solid color-mix(in srgb, var(--cc-accent) 35%, transparent);
  background: var(--cc-accent-soft); color: var(--cc-accent);
  border-radius: 999px; padding: 1px 10px; font-size: 11px; font-weight: 500;
}
.cc-usage-note { padding: 3px 18px; font-size: 11px; color: var(--cc-text-3); border-bottom: 1px solid var(--cc-border-soft); }
.cc-usage-reset { font-style: normal; font-size: 10px; color: var(--cc-text-3); margin-left: 3px; }

/* ── right-edge dock ─────────────────────────────────────── */
.cc-dock {
  position: fixed; right: 0; top: 50%; transform: translateY(-50%); z-index: 9900;
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  border: 1px solid var(--cc-border); border-right: none;
  border-radius: 12px 0 0 12px;
  background: var(--cc-panel); color: var(--cc-text);
  padding: 14px 8px; cursor: pointer;
  box-shadow: var(--cc-shadow-md);
  font-family: -apple-system, "Segoe UI", "PingFang SC", sans-serif;
  font-size: 12px; line-height: 1.3;
  transition: background 140ms, border-color 140ms, padding 140ms var(--cc-ease);
}
.cc-dock:hover { background: var(--cc-accent-soft); border-color: var(--cc-accent); padding-right: 12px; }
.cc-dock-label {
  writing-mode: vertical-rl; letter-spacing: 2.5px; user-select: none;
  white-space: nowrap; font-weight: 500; color: var(--cc-text-2);
}
.cc-dock:hover .cc-dock-label { color: var(--cc-accent); }

/* ── footer entry (legacy mount point, renders nothing) ──── */
.cc-footer-row { display: none; }
.cc-footer-btn { display: none; }

/* ── scrollbars ──────────────────────────────────────────── */
.cc-scroll::-webkit-scrollbar, .cc-session-list::-webkit-scrollbar,
.cc-picker-list::-webkit-scrollbar, .cc-modal::-webkit-scrollbar { width: 8px; height: 8px; }
.cc-scroll::-webkit-scrollbar-thumb, .cc-session-list::-webkit-scrollbar-thumb,
.cc-picker-list::-webkit-scrollbar-thumb, .cc-modal::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--cc-text-3) 35%, transparent);
  border-radius: 4px; border: 2px solid transparent; background-clip: content-box;
}
.cc-scroll::-webkit-scrollbar-thumb:hover, .cc-session-list::-webkit-scrollbar-thumb:hover,
.cc-picker-list::-webkit-scrollbar-thumb:hover, .cc-modal::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--cc-text-3) 60%, transparent); background-clip: content-box;
}
.cc-scroll::-webkit-scrollbar-track, .cc-session-list::-webkit-scrollbar-track,
.cc-picker-list::-webkit-scrollbar-track, .cc-modal::-webkit-scrollbar-track { background: transparent; }

@media (prefers-reduced-motion: reduce) {
  .cc-overlay, .cc-app, .cc-perm, .cc-modal, .cc-modal-backdrop { animation: none; }
  .cc-btn, .cc-q-option, .cc-dock, .cc-session-row, .cc-session-del { transition: none; }
  .cc-scroll { scroll-behavior: auto; }
}
`

/** Minimal light-DOM sheet: only the sidebar footer button lives outside the overlay. */
export const FOOTER_CSS = `
.cc-footer-btn { display: none; }
`

/**
 * Inject one stylesheet once per document under the given id.
 * @param id - unique style element id.
 * @param css - the stylesheet text.
 */
export function injectOnce(id: string, css: string): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(id) !== null) return
  const tag = document.createElement('style')
  tag.id = id
  tag.textContent = css
  document.head.appendChild(tag)
}

/** @deprecated use {@link injectOnce} with a named sheet; kept for the light-DOM button. */
export const injectStylesOnce = (): void => injectOnce('dsh-cc-footer-styles', FOOTER_CSS)
