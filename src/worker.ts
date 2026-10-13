// Unified Worker entrypoint (Astro 7 + @astrojs/cloudflare v14).
//
// This project runs one Worker that serves both the Astro SSR site and the
// backend API/pipeline that used to live in a separate Worker (worker/index.js):
//   - fetch:     API routes (/api/*, /mcp) → backend handler; everything else
//                falls through to Astro SSR (pages, assets).
//   - scheduled: RSS ingestion / translation cron → backend handler.
//   - queue:     translation queue consumer → backend handler.
//
// The @astrojs/cloudflare adapter's `handle` runs the Astro request pipeline
// (static assets via the ASSETS binding + on-demand rendered routes).
import { handle } from '@astrojs/cloudflare/handler';
import backend from '../worker/index.js';

// PRIMARY_HOST is intentionally NOT a wrangler.toml [vars] entry (so it stays
// unset — and the redirect stays off — by default). Declare it as an optional
// runtime var so the migration switch can read env.PRIMARY_HOST type-safely.
declare global {
  interface Env {
    PRIMARY_HOST?: string;
  }
}

// Paths owned by the backend API. Anything else is an Astro route.
const API_PREFIXES = ['/api/', '/mcp'];

function isApiRequest(pathname: string): boolean {
  return API_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
}

// NOTE: vulnerability-scanner probes (/wp-*, /.env, service-account json,
// path traversal, etc.) are blocked at the edge by a free-tier WAF custom rule
// ("Block vulnerability-scanner probe paths"), configured via
// .github/workflows/waf-setup.yml. Blocking at the WAF stops the request before
// it reaches this Worker, so it never burns a D1 query or files an
// observability issue — and there's no scanner pattern list to maintain here.

// Astro's Cloudflare adapter builds a Worker whose responses are NOT
// automatically stored in Cloudflare's CDN cache — a Worker fetch response
// bypasses the edge cache unless we explicitly use the Cache API. Page routes
// set `Cache-Control: s-maxage=60, stale-while-revalidate=300` (see
// [csp].astro), but without this layer every request re-ran the full SSR
// render + backend D1 query, which showed up as a variable TTFB and large
// LCP spikes in the field. This wraps GET page renders in the Cache API so a
// hit serves cached HTML in ~tens of ms with no D1 round-trip.
async function withEdgeCache(
  request: Request,
  ctx: ExecutionContext,
  render: () => Promise<Response>,
): Promise<Response> {
  // Only cache top-level GET navigations. Skip anything with cookies/auth so
  // we never cache a personalized response.
  if (request.method !== 'GET' || request.headers.has('authorization') || request.headers.has('cookie')) {
    return render();
  }
  const cache = (caches as unknown as { default: Cache }).default;
  // Normalize the cache key to the URL only (drop the request's own headers).
  const cacheKey = new Request(new URL(request.url).toString(), { method: 'GET' });

  const cached = await cache.match(cacheKey);
  if (cached) {
    const hit = new Response(cached.body, cached);
    hit.headers.set('X-Edge-Cache', 'HIT');
    return hit;
  }

  const response = await render();

  // Only store cacheable successes that opted in via s-maxage. HTML pages do;
  // redirects (302 for unknown slugs) and errors do not.
  const cc = response.headers.get('Cache-Control') || '';
  if (response.status === 200 && /s-maxage=\d+/.test(cc)) {
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    const miss = new Response(response.body, response);
    miss.headers.set('X-Edge-Cache', 'MISS');
    return miss;
  }
  return response;
}

// Host canonicalization (domain migration switch, OFF by default).
//
// When the PRIMARY_HOST var is set (e.g. "whats-new.cloud"), any site request
// arriving on a different host is redirected to the same path+query on
// PRIMARY_HOST. API hosts (api.*) are never redirected — programmatic/MCP
// clients must keep hitting the host they were given. With PRIMARY_HOST unset
// (the default today) this is a no-op, so .kr and .cloud both serve directly
// until we flip the var.
//
// Uses a 302 (temporary) on purpose: this is a flippable migration switch, and
// a 301 is cached permanently by browsers — flipping it off would not bring
// already-redirected clients back. Promote to 301 only once the move to
// PRIMARY_HOST is final and we no longer intend to toggle it off.
//
// Flip procedure (no code redeploy needed, just vars):
//   wrangler secret put PRIMARY_HOST   # or [vars] PRIMARY_HOST = "whats-new.cloud"
//   and set SITE_URL=https://whats-new.cloud so canonical/OG/sitemap follow.
function canonicalHostRedirect(request: Request, env: Env): Response | null {
  const primary = String(env.PRIMARY_HOST || '').trim();
  if (!primary) return null;
  const url = new URL(request.url);
  // Never redirect API/MCP hosts or the primary host itself.
  if (url.hostname === primary || url.hostname.startsWith('api.')) return null;
  url.hostname = primary;
  return Response.redirect(url.toString(), 302);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Domain-migration redirect (no-op unless PRIMARY_HOST is set).
    const redirect = canonicalHostRedirect(request, env);
    if (redirect) return redirect;

    // Strip the internal-SSR trust header from every inbound external request
    // so it can't be forged. Only this Worker's own SSR (via apiClient's
    // in-process callBackend) is allowed to set it; see worker/index.js
    // (isInternalSsrCall) for the /api/articles gate bypass it unlocks.
    let safeRequest = request;
    if (request.headers.has('X-Internal-SSR')) {
      const headers = new Headers(request.headers);
      headers.delete('X-Internal-SSR');
      safeRequest = new Request(request, { headers });
    }

    const { pathname } = new URL(safeRequest.url);
    if (isApiRequest(pathname)) {
      return backend.fetch(safeRequest, env, ctx);
    }
    return withEdgeCache(safeRequest, ctx, () => handle(safeRequest, env as never, ctx));
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    return backend.scheduled(event, env, ctx);
  },

  async queue(batch: MessageBatch, env: Env, ctx: ExecutionContext): Promise<void> {
    return backend.queue(batch, env, ctx);
  },
} satisfies ExportedHandler<Env>;
