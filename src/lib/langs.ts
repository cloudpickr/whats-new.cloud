// Supported UI languages. The backend (/api/articles, MCP) already stores and
// serves ko/en/ja; this is the frontend's single source for language metadata.
//
// Language is modeled as a QUERY-STRING ATTRIBUTE (?lang=ja), mirroring the MCP
// tools where language is a `lang` argument on a resource rather than a
// separate path. ko is the default and omits the param, keeping /aws clean and
// its existing search index intact.

export interface Lang {
  /** ?lang= value and <html lang> / hreflang code family. */
  id: 'ko' | 'en' | 'ja';
  /** Short label for the switcher. */
  label: string;
  /** Flag emoji for the compact switcher (legible on mobile). */
  flag: string;
  /** 2-letter code shown alongside the flag (fallback where flag emoji don't render, e.g. Windows). */
  code: string;
  /** BCP-47 tag for <html lang> and Intl date formatting. */
  bcp47: string;
  /** Open Graph locale. */
  ogLocale: string;
  /** hreflang value. */
  hreflang: string;
}

export const LANGS: Record<Lang['id'], Lang> = {
  ko: { id: 'ko', label: '한국어', flag: '🇰🇷', code: 'KO', bcp47: 'ko-KR', ogLocale: 'ko_KR', hreflang: 'ko' },
  en: { id: 'en', label: 'English', flag: '🇺🇸', code: 'EN', bcp47: 'en-US', ogLocale: 'en_US', hreflang: 'en' },
  ja: { id: 'ja', label: '日本語', flag: '🇯🇵', code: 'JA', bcp47: 'ja-JP', ogLocale: 'ja_JP', hreflang: 'ja' },
};

export const LANG_IDS = Object.keys(LANGS) as Lang['id'][];
export const DEFAULT_LANG: Lang['id'] = 'ko';

/** Narrow an arbitrary string to a supported lang id, falling back to ko. */
export function resolveLang(raw: string | null | undefined): Lang['id'] {
  return raw === 'en' || raw === 'ja' ? raw : DEFAULT_LANG;
}

/**
 * Build a URL for the current path with ?lang applied (ko omits the param).
 * Preserves other existing query params (e.g. a shared ?status=/?q=) — use this
 * for the language SWITCHER, where changing language from a filtered view
 * should keep the filter.
 */
export function langUrl(url: URL, lang: Lang['id']): string {
  const u = new URL(url.toString());
  if (lang === DEFAULT_LANG) u.searchParams.delete('lang');
  else u.searchParams.set('lang', lang);
  return u.pathname + (u.search ? u.search : '');
}

/**
 * Build a canonical/hreflang URL: path + ONLY ?lang (ko omits it). Drops
 * status/q and any other params so a shared filter link
 * (/aws?status=...&q=...) does not fragment indexing or carry one language's
 * status vocabulary onto another language's alternate. Use this for SEO head
 * links, never for the switcher.
 */
export function seoLangUrl(url: URL, lang: Lang['id']): string {
  const search = lang === DEFAULT_LANG ? '' : `?lang=${lang}`;
  return url.pathname + search;
}
