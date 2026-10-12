// Single source of truth for the cloud providers (CSPs) the site renders.
//
// Before this file, the CSP list and each provider's name/color/font/official
// feed were hardcoded in ~5 places (index.astro home columns, [csp].astro route
// guard + names + rssLinks, Layout.astro nav + cspNames + fontPreload,
// sitemap.xml.ts). Adding or editing a provider meant touching all of them and
// risking drift. Every consumer now imports from here, so a provider is defined
// once.
//
// Values are copied verbatim from the previous inline definitions — this is a
// behavior-preserving refactor, not a visual change.

export interface Provider {
  /** URL slug and DB `csp` value, e.g. "aws". Also the data-vendor theme key. */
  id: string;
  /** Full brand name shown as the page H1 / home column heading. */
  name: string;
  /** Home column heading, if it should differ from `name` (else uses name). */
  homeName?: string;
  /** Short label shown in the top nav. */
  nav: string;
  /** Primary brand color (home column accent dot / link color). */
  color: string;
  /** Secondary accent (used by gradient/brand treatments). */
  accent: string;
  /** CSS font-family stack for the brand face. */
  font: string;
  /** True for GCP's 4-color gradient treatment. */
  isGradient?: boolean;
  /** Optional font-weight override for the home column heading. */
  weight?: number;
  /** Official vendor release feed: label + URL. */
  official: { name: string; url: string };
  /** Brand font to <link rel=preload> in the head, if any. */
  fontPreload?: string;
  /** Top-level category — lets future non-CSP sections (e.g. AI) coexist. */
  category: 'csp';
}

export const PROVIDERS: Record<string, Provider> = {
  aws: {
    id: 'aws',
    name: 'Amazon Web Services',
    nav: 'AWS',
    color: '#FF9900',
    accent: '#232F3E',
    font: "'Amazon Ember', sans-serif",
    official: { name: "AWS What's New", url: 'https://aws.amazon.com/new/' },
    fontPreload: '/fonts/amazon-ember-400.woff2',
    category: 'csp',
  },
  gcp: {
    id: 'gcp',
    name: 'Google Cloud',
    nav: 'GCP',
    color: 'linear-gradient(to right, #4285F4 25%, #EA4335 25%, #EA4335 50%, #FBBC04 50%, #FBBC04 75%, #34A853 75%)',
    accent: '#4285F4',
    font: "'Google Sans', sans-serif",
    isGradient: true,
    weight: 700,
    official: { name: 'Google Cloud Release Notes', url: 'https://cloud.google.com/release-notes' },
    category: 'csp',
  },
  azure: {
    id: 'azure',
    name: 'Microsoft Azure',
    nav: 'Azure',
    color: '#0078D4',
    accent: '#50E6FF',
    font: "'Segoe UI Web', 'Segoe UI', sans-serif",
    official: { name: 'Azure Updates', url: 'https://azure.microsoft.com/en-us/updates/' },
    fontPreload: 'https://c.s-microsoft.com/static/fonts/segoe-ui/west-european/Normal/latest.woff2',
    category: 'csp',
  },
  oci: {
    id: 'oci',
    name: 'Oracle Cloud Infrastructure',
    homeName: 'Oracle Cloud',
    nav: 'OCI',
    color: '#C74634',
    accent: '#C74634',
    font: "'Oracle Sans', -apple-system, 'Helvetica Neue', 'Segoe UI', Roboto, sans-serif",
    weight: 600,
    official: { name: 'OCI Release Notes', url: 'https://docs.oracle.com/en-us/iaas/releasenotes/' },
    fontPreload: '/fonts/oracle-sans-600.woff2',
    category: 'csp',
  },
};

/** Provider ids in display order. Used by route guards, nav, sitemap. */
export const PROVIDER_IDS: string[] = Object.keys(PROVIDERS);

/** Ordered provider objects, for `.map()` in templates. */
export const PROVIDER_LIST: Provider[] = PROVIDER_IDS.map((id) => PROVIDERS[id]);

export function isProvider(id: string | undefined): id is string {
  return !!id && id in PROVIDERS;
}

/** Short nav label for home + each provider (home has no Provider entry). */
export const NAV_LABELS: Record<string, string> = {
  home: "Cloud What's New",
  ...Object.fromEntries(PROVIDER_LIST.map((p) => [p.id, p.nav])),
};
