'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { t } from '@/shared/i18n';

/**
 * The upload control.
 *
 * It posts to A3's `/api/media/upload` rather than to a server action, and that is not a style
 * choice: that handler reads the body through a counting reader that stops at the platform
 * ceiling BEFORE anything is buffered, charges the rate limit before the read, verifies magic
 * bytes, and applies both plan limits. A server action would have materialised the whole file
 * first and then asked whether it was allowed.
 *
 * Every refusal it can return already carries an ARABIC sentence (`MediaError.arabicMessage`),
 * so this component renders the server's message verbatim and holds no error copy of its own —
 * which is also why the plan's own numbers ("your plan allows 2 ميغابايت") reach the merchant
 * intact.
 *
 * The alt text is asked for HERE, before the upload, because it is required on a product image
 * and asking later means a library full of photos nobody can use.
 */
export function MediaUploader() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(form: FormData) {
    setPending(true);
    setError(null);
    setDone(false);

    try {
      const response = await fetch('/api/media/upload', { method: 'POST', body: form });
      const payload = (await response.json().catch(() => null)) as
        | { ok?: boolean; message?: string }
        | null;

      if (!response.ok || !payload?.ok) {
        // The server's own Arabic sentence, with its own numbers in it.
        setError(payload?.message ?? t('media', 'errors.server'));
        return;
      }

      setDone(true);
      router.refresh();
    } catch {
      setError(t('media', 'errors.server'));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="sbd-form" action={submit}>
      {error ? (
        <div className="sbd-notice sbd-notice--error" role="alert">
          {error}
        </div>
      ) : null}

      {done ? (
        <div className="sbd-notice sbd-notice--ok" role="status">
          {t('dashboard', 'media.uploaded')}
        </div>
      ) : null}

      <div className="sbd-grid">
        <div className="sbd-field">
          <label className="sbd-label" htmlFor="file">
            {t('dashboard', 'media.chooseFile')}
          </label>
          <input
            className="sbd-input"
            id="file"
            name="file"
            type="file"
            // Uploaded SVG is never accepted — A3 refuses it by magic bytes, and this hint keeps
            // a merchant from picking one only to be told no.
            accept="image/jpeg,image/png,image/webp"
            required
          />
        </div>

        <div className="sbd-field">
          <label className="sbd-label" htmlFor="altText">
            {t('media', 'altLabel')}
          </label>
          <input className="sbd-input" id="altText" name="altText" type="text" required />
          <span className="sbd-hint">{t('dashboard', 'media.altPrompt')}</span>
        </div>
      </div>

      <div className="sbd-actions">
        <button type="submit" className="sbd-btn sbd-btn--primary" disabled={pending}>
          {pending ? t('dashboard', 'media.uploading') : t('media', 'upload')}
        </button>
      </div>
    </form>
  );
}
