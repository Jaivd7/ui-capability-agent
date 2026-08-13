import type { Page } from "playwright";

export interface DialogEvent {
  type: string;
  message: string;
  accepted: boolean;
}

/**
 * Native browser dialogs (window.confirm/alert/prompt) are a page-level
 * event, not a DOM element — they don't fit the artifact's knownOutcomes
 * mechanism (which detects state via a locator). An unhandled dialog also
 * blocks all further Playwright commands on the page, so it can't be left
 * to either the LLM (discovery) or a declarative detector (replay) to
 * notice and react — it has to be handled generically, at the session
 * level, before it can ever cause a hang. Both the discovery loop and the
 * replay engine install this same listener for that reason; see
 * REPORT.md §3 for why this is a deliberate split from knownOutcomes
 * rather than an oversight.
 *
 * Policy: always accept. A confirm() the automation can't safely dismiss
 * unattended is exactly the kind of judgment call this project's guardrail
 * model pushes to irreversible-step gating (Phase 4), not to dialog
 * handling — blocking on an OK/Cancel dialog isn't a substitute for that.
 */
export function installDialogAutoAccept(page: Page, onDialog: (info: DialogEvent) => void): void {
  page.on("dialog", (dialog) => {
    const info = { type: dialog.type(), message: dialog.message(), accepted: true };
    onDialog(info);
    void dialog.accept();
  });
}
