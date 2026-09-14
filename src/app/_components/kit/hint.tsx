import { t } from '@/shared/i18n';

/**
 * The «!» hint — one tap opens a short explanation next to the thing it explains (2026-09-13,
 * owner-directed: «أي إشي مبهم حط إشارة تعجب وتوضيح لما ينضغط عليها»).
 *
 * A native `<details>`, on purpose:
 *   - keyboard-reachable and screen-reader-announced with no script (the summary is a button);
 *   - toggles with Enter/Space, closes by clicking again — the pattern the browser already knows;
 *   - RTL-first: the panel opens on the inline-start side and never leaves the viewport on a phone.
 * Design contract («مرصد»): no accent-coloured furniture. The mark is ink on the panel colour; the
 * open panel is the raised surface with a hairline. Motion budget: opacity only, 150ms.
 *
 * `text` is a resolved Arabic string — the caller passes `t(...)` so the language gate can see it.
 */
export function Hint({ text, label }: { text: string; label?: string }) {
  return (
    <details className="sbk-hint">
      <summary className="sbk-hint__mark" aria-label={label ?? t('common', 'hint.open')}>
        <span aria-hidden="true">!</span>
      </summary>
      <div className="sbk-hint__panel" role="note">
        {text}
      </div>
    </details>
  );
}
