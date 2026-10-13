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
  /** BCP-47 tag for <html lang> and Intl date formatting. */
  bcp47: string;
  /** Open Graph locale. */
  ogLocale: string;
  /** hreflang value. */
  hreflang: string;
}

export const LANGS: Record<Lang['id'], Lang> = {
  ko: { id: 'ko', label: '한국어', flag: '🇰🇷', bcp47: 'ko-KR', ogLocale: 'ko_KR', hreflang: 'ko' },
  en: { id: 'en', label: 'English', flag: '🇺🇸', bcp47: 'en-US', ogLocale: 'en_US', hreflang: 'en' },
  ja: { id: 'ja', label: '日本語', flag: '🇯🇵', bcp47: 'ja-JP', ogLocale: 'ja_JP', hreflang: 'ja' },
};

export const LANG_IDS = Object.keys(LANGS) as Lang['id'][];
export const DEFAULT_LANG: Lang['id'] = 'ko';

/** Cookie that remembers the chosen language so SSR can honor it without a
 *  ?lang= in the URL (the query is then only for explicit/shared links). */
export const LANG_COOKIE = 'lang';

/** Narrow an arbitrary string to a supported lang id, falling back to ko. */
export function resolveLang(raw: string | null | undefined): Lang['id'] {
  return raw === 'en' || raw === 'ja' ? raw : DEFAULT_LANG;
}

/** Read our lang cookie from a raw Cookie header. */
export function langFromCookie(cookieHeader: string | null | undefined): Lang['id'] | null {
  if (!cookieHeader) return null;
  const m = cookieHeader.match(/(?:^|;\s*)lang=(ko|en|ja)(?:;|$)/);
  return m ? (m[1] as Lang['id']) : null;
}

/**
 * Pick a supported UI language from an Accept-Language header, honoring the
 * client's quality (q) ordering. Returns null if none of ko/en/ja is requested.
 * e.g. "ja,en-US;q=0.9,en;q=0.8" → 'ja'; "fr-FR,fr;q=0.9" → null.
 */
export function langFromAcceptLanguage(header: string | null | undefined): Lang['id'] | null {
  if (!header) return null;
  const ranked = header
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const qParam = params.find((p) => p.trim().startsWith('q='));
      const q = qParam ? parseFloat(qParam.trim().slice(2)) : 1;
      return { base: tag.trim().toLowerCase().split('-')[0], q: Number.isFinite(q) ? q : 0 };
    })
    .filter((e) => e.base === 'ko' || e.base === 'en' || e.base === 'ja')
    .sort((a, b) => b.q - a.q);
  return ranked.length ? (ranked[0].base as Lang['id']) : null;
}

/**
 * Resolve the active language for SSR, with the intended precedence:
 *   explicit ?lang= query  >  saved `lang` cookie  >  ko default.
 * This lets a bare URL (/aws) render the user's saved language from the cookie
 * without putting ?lang= in the URL, while a shared ?lang= link still wins.
 */
/**
 * Resolve the active language for SSR, with the intended precedence:
 *   explicit ?lang= query  >  saved `lang` cookie  >  Accept-Language  >  ko.
 * A bare URL (/aws) with no cookie renders in the visitor's browser language
 * when it's one we support, otherwise ko. An explicit choice (query/cookie)
 * always wins over the browser header.
 */
export function resolveActiveLang(
  searchParams: URLSearchParams,
  cookieHeader: string | null | undefined,
  acceptLanguage?: string | null,
): Lang['id'] {
  const q = searchParams.get('lang');
  if (q === 'en' || q === 'ja' || q === 'ko') return resolveLang(q);
  return langFromCookie(cookieHeader) ?? langFromAcceptLanguage(acceptLanguage) ?? DEFAULT_LANG;
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
