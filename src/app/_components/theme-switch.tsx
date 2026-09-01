'use client';

import { useRef, useState } from 'react';
import { t } from '@/shared/i18n';
import {
  UI_ACCENTS,
  UI_ACCENT_COOKIE,
  UI_THEME_COOKIE,
  UI_THEME_COOKIE_MAX_AGE,
  type UiAccentKey,
  type UiTheme,
} from '@/shared/ui-theme';

/**
 * The dark/light toggle and the accent picker, shared by both private surfaces.
 *
 * It styles itself against the `--sbx-*` bridge variables, which each surface maps onto its own
 * tokens (`admin.css` / `dashboard.css`) — one component, two design systems, zero duplicated
 * CSS. The initial state arrives as props from the server layout (which read the same cookies
 * that decided the SSR attributes), so hydration always agrees with the first paint.
 *
 * The flip is attribute + cookie, no navigation: the tokens cascade from the `[data-surface]`
 * root, so restyling the whole shell is two `setAttribute` calls. `router.refresh()` is
 * deliberately NOT called — nothing the server rendered depends on the theme except the
 * attributes this component just set by hand.
 */

function writeCookie(name: string, value: string) {
  document.cookie = `${name}=${value}; path=/; max-age=${UI_THEME_COOKIE_MAX_AGE}; samesite=lax`;
}

export function ThemeSwitch({
  initialTheme,
  initialAccent,
}: {
  initialTheme: UiTheme;
  initialAccent: UiAccentKey | null;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [theme, setTheme] = useState<UiTheme>(initialTheme);
  const [accent, setAccent] = useState<UiAccentKey | null>(initialAccent);

  function surfaceRoot(): HTMLElement | null {
    return rootRef.current?.closest('[data-surface]') ?? null;
  }

  function applyTheme(next: UiTheme) {
    setTheme(next);
    surfaceRoot()?.setAttribute('data-theme', next);
    writeCookie(UI_THEME_COOKIE, next);
  }

  function applyAccent(next: UiAccentKey) {
    setAccent(next);
    surfaceRoot()?.setAttribute('data-accent', next);
    writeCookie(UI_ACCENT_COOKIE, next);
  }

  const dark = theme === 'dark';

  return (
    <div className="sbx-theme" ref={rootRef}>
      <button
        type="button"
        className="sbx-mode"
        onClick={() => applyTheme(dark ? 'light' : 'dark')}
        aria-pressed={dark}
        aria-label={t('common', dark ? 'theme.toLight' : 'theme.toDark')}
        title={t('common', dark ? 'theme.toLight' : 'theme.toDark')}
      >
        {/* Sun / moon drawn inline: no icon font, no emoji, recolours with the tokens. */}
        <svg
          className="sbx-mode-icon"
          viewBox="0 0 20 20"
          aria-hidden="true"
          focusable="false"
        >
          {dark ? (
            <path d="M15.5 11.8A6.3 6.3 0 0 1 8.2 4.5a6.3 6.3 0 1 0 7.3 7.3Z" fill="currentColor" />
          ) : (
            <>
              <circle cx="10" cy="10" r="3.6" fill="currentColor" />
              <g stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <path d="M10 1.8v2M10 16.2v2M1.8 10h2M16.2 10h2M4.2 4.2l1.4 1.4M14.4 14.4l1.4 1.4M15.8 4.2l-1.4 1.4M5.6 14.4l-1.4 1.4" />
              </g>
            </>
          )}
        </svg>
        <span className="sbx-mode-label">
          {t('common', dark ? 'theme.dark' : 'theme.light')}
        </span>
      </button>

      <div
        className="sbx-accents"
        role="radiogroup"
        aria-label={t('common', 'theme.accentLabel')}
      >
        {UI_ACCENTS.map((option) => {
          const name = t('common', `theme.accents.${option.key}`);
          return (
            <button
              key={option.key}
              type="button"
              role="radio"
              className="sbx-accent-dot"
              aria-checked={accent === option.key}
              aria-label={t('common', 'theme.accentOf', { name })}
              title={name}
              style={{ background: option.dot }}
              onClick={() => applyAccent(option.key)}
            />
          );
        })}
      </div>
    </div>
  );
}
