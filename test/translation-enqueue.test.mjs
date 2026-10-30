import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchRSS, RSS_FEEDS } from '../worker/index.js';

// Exercise ingestion through claiming and queue delivery. 23 new articles
// produce the 69 candidates reported in GH #110.
function ingestionEnv(claim, sendBatch = async () => {}) {
  const released = [];
  return {
    released,
    TRANSLATION_QUEUE: { sendBatch },
    DB: {
      prepare(sql) {
        const statement = {
          sql,
          values: [],
          bind(...values) { statement.values = values; return statement; },
          async run() { return { meta: { changes: 0 } }; },
        };
        return statement;
      },
      async batch(statements) {
        return statements.map(({ sql, values }, index) => {
          if (sql.includes('SELECT id FROM articles')) return { results: [{ id: index + 1 }] };
          if (sql.includes('INSERT OR IGNORE INTO translation_job_state')) {
            return { meta: { changes: claim(values) ? 1 : 0 } };
          }
          if (sql.includes('DELETE FROM translation_job_state')) released.push(values);
          return { meta: { changes: 1 } };
        });
      },
    },
  };
}

function mockIngestion(t) {
  const items = Array.from({ length: 23 }, (_, i) => `
    <item><title>Release ${i}</title><link>https://example.com/${i}</link>
    <pubDate>Thu, 29 Oct 2026 00:00:00 GMT</pubDate></item>`).join('');
  t.mock.method(globalThis, 'fetch', async (url) => new Response(
    `<rss><channel>${url === RSS_FEEDS.aws ? items : ''}</channel></rss>`,
  ));
  return t.mock.method(console, 'error', () => {});
}

test('all 69 candidates already localized or claimed is a successful no-op', async (t) => {
  const errors = mockIngestion(t);
  let sends = 0;
  const env = ingestionEnv(() => false, async () => { sends++; });
  assert.deepEqual(await fetchRSS(env), { newArticles: 23, queued: 0 });
  assert.equal(sends, 0);
  assert.equal(errors.mock.callCount(), 0);
});

test('only claimed jobs are sent and counted', async (t) => {
  const errors = mockIngestion(t);
  const sent = [];
  // Ingestion seeds English rows; only ko/ja need new translation claims.
  const env = ingestionEnv((values) => values[1] !== 'en', async (batch) => sent.push(...batch));
  assert.deepEqual(await fetchRSS(env), { newArticles: 23, queued: 46 });
  assert.equal(sent.length, 46);
  assert.ok(sent.every(({ body }) => body.lang !== 'en'));
  assert.equal(errors.mock.callCount(), 0);
});

test('real queue failures reject and release claims for retry', async (t) => {
  const errors = mockIngestion(t);
  const failure = new Error('queue unavailable');
  const env = ingestionEnv(() => true, async () => { throw failure; });
  await assert.rejects(fetchRSS(env), (error) => error === failure);
  assert.equal(env.released.length, 69);
  assert.equal(errors.mock.callCount(), 1);
  assert.match(errors.mock.calls[0].arguments[0], /queue unavailable/);
});

test('missing queue binding rejects instead of silently reporting zero', async (t) => {
  mockIngestion(t);
  const env = ingestionEnv(() => true);
  delete env.TRANSLATION_QUEUE;
  await assert.rejects(fetchRSS(env), /TRANSLATION_QUEUE binding is required/);
});

test('empty feeds do not require a queue binding', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('<rss><channel></channel></rss>'));
  const env = ingestionEnv(() => true);
  delete env.TRANSLATION_QUEUE;
  assert.deepEqual(await fetchRSS(env), { newArticles: 0, queued: 0 });
});
