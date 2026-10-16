/**
 * Mailbox view styles: one plain stylesheet injected once per document.
 * Hand-rolled because the shared tsdown CSS pipeline is a repository-package
 * facility; class names carry the `dsw-mailbox-` prefix instead of CSS-module
 * hashing, and colors come from the shared `--dsw-alias-*` tokens.
 */

export const MAILBOX_STYLES = `
.dsw-mailbox-root {
  overflow: auto;
  padding: 12px 16px 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  color: var(--dsw-alias-label-primary);
}
.dsw-mailbox-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: none;
}
.dsw-mailbox-button {
  border: none;
  border-radius: 6px;
  padding: 4px 12px;
  font: 500 12px/18px var(--dsw-font-family);
  color: var(--dsw-alias-label-primary);
  background: transparent;
  cursor: pointer;
}
.dsw-mailbox-button:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsw-mailbox-button:focus-visible {
  outline: 1px solid var(--dsw-alias-state-business-primary);
}
.dsw-mailbox-auto {
  display: flex;
  align-items: center;
  gap: 5px;
  font: 400 12px/18px var(--dsw-font-family);
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  user-select: none;
}
.dsw-mailbox-updated {
  font: 400 12px/18px var(--dsw-font-family);
  color: var(--dsw-alias-label-tertiary);
}
.dsw-mailbox-loading {
  font: 400 12px/18px var(--dsw-font-family);
  color: var(--dsw-alias-label-tertiary);
}
.dsw-mailbox-error {
  font: 400 12px/18px var(--dsw-font-family);
  color: var(--dsw-alias-state-error-primary);
}
.dsw-mailbox-box {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.dsw-mailbox-boxHeader {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}
.dsw-mailbox-boxName {
  font: 600 13px/20px var(--dsw-font-family);
  color: var(--dsw-alias-label-primary);
}
.dsw-mailbox-chip {
  font: 400 11px/16px var(--dsw-font-family);
  color: var(--dsw-alias-label-tertiary);
  background: var(--dsw-alias-bg-module-platform);
  border-radius: 4px;
  padding: 1px 6px;
}
.dsw-mailbox-live {
  font: 400 11px/16px var(--dsw-font-family);
  color: var(--dsw-alias-label-tertiary);
}
.dsw-mailbox-liveDot {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  margin-right: 4px;
  vertical-align: 1px;
  background: var(--dsw-alias-label-caption);
}
.dsw-mailbox-liveDot.on {
  background: var(--dsw-alias-state-success-primary);
}
.dsw-mailbox-pendingChip {
  font: 500 11px/16px var(--dsw-font-family);
  color: var(--dsw-alias-state-warn-label);
  background: var(--dsw-alias-state-warn-tertiary);
  border-radius: 4px;
  padding: 1px 6px;
}
.dsw-mailbox-cards {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.dsw-mailbox-card {
  background: var(--dsw-alias-bg-module-platform);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  box-shadow: var(--dsw-elevation-panel);
}
.dsw-mailbox-card.pending {
  box-shadow: inset 2px 0 0 var(--dsw-alias-state-business-primary), var(--dsw-elevation-panel);
}
.dsw-mailbox-cardHead {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font: 400 12px/18px var(--dsw-font-family);
  color: var(--dsw-alias-label-secondary);
}
.dsw-mailbox-from {
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.dsw-mailbox-topic {
  font: 500 11px/16px var(--dsw-font-family);
  color: var(--dsw-alias-state-business-primary);
  background: var(--dsw-alias-state-business-tertiary);
  border-radius: 4px;
  padding: 1px 6px;
}
.dsw-mailbox-pendingBadge {
  font: 500 11px/16px var(--dsw-font-family);
  color: var(--dsw-alias-state-warn-label);
  background: var(--dsw-alias-state-warn-tertiary);
  border-radius: 4px;
  padding: 1px 6px;
}
.dsw-mailbox-time {
  margin-left: auto;
  font: 400 11px/16px var(--dsw-font-family);
  color: var(--dsw-alias-label-caption);
}
.dsw-mailbox-body {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: 400 13px/20px var(--dsw-font-family);
  color: var(--dsw-alias-label-primary);
}
.dsw-mailbox-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  font: 400 11px/16px var(--dsw-font-family);
  color: var(--dsw-alias-label-tertiary);
}
.dsw-mailbox-metaKey {
  color: var(--dsw-alias-label-caption);
}
.dsw-mailbox-metaValue {
  color: var(--dsw-alias-label-secondary);
  font-family: var(--ds-font-family-code, monospace);
  font-size: 10px;
}
.dsw-mailbox-empty {
  padding: 32px 0;
  text-align: center;
  font: 400 13px/20px var(--dsw-font-family);
  color: var(--dsw-alias-label-tertiary);
}
`

const STYLE_ID = 'dsw-session-mail-styles'

/**
 * Inject the stylesheet once per document (idempotent across remounts).
 */
export function ensureStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID) !== null) return
  const tag = document.createElement('style')
  tag.id = STYLE_ID
  tag.textContent = MAILBOX_STYLES
  document.head.appendChild(tag)
}
