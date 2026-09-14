import type { Metadata } from 'next';
import { t } from '@/shared/i18n';
import './platform.css';

/**
 * The platform's own pages — `{DOMAIN}` and nothing else (2026-09-13).
 *
 * Indexable, unlike every other surface: this is the one page the platform WANTS a search engine
 * to find. The title template is the root's; only the default changes.
 */
export const metadata: Metadata = {
  title: { absolute: `${t('common', 'app.name')} — ${t('common', 'platform.title')}` },
  description: t('common', 'platform.metaDescription'),
  robots: { index: true, follow: true },
};

export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  return <div data-surface="platform">{children}</div>;
}
