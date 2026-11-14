-- Source of truth: raw ingestion + dedup
CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  csp TEXT NOT NULL,
  url TEXT NOT NULL,
  title_en TEXT NOT NULL,
  description_en TEXT,
  pub_date TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(csp, url, title_en)
);

-- Denormalized read table: all languages including English
CREATE TABLE IF NOT EXISTS localized_content (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL REFERENCES articles(id),
  csp TEXT NOT NULL,
  lang TEXT NOT NULL,
  url TEXT NOT NULL,
  pub_date TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  target TEXT,
  features TEXT,
  regions TEXT,
  status TEXT,
  model_used TEXT,
  translated_model TEXT,
  translated_at TEXT,
  reviewed_model TEXT,
  reviewed_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(article_id, lang)
);

-- Hot-path indexes: no JOIN needed
CREATE INDEX IF NOT EXISTS idx_lc_lang_csp_date ON localized_content(lang, csp, pub_date DESC);
CREATE INDEX IF NOT EXISTS idx_lc_lang_date ON localized_content(lang, pub_date DESC);
CREATE INDEX IF NOT EXISTS idx_articles_csp ON articles(csp);
-- Backlog sweep (articles NOT EXISTS localized_content, filtered by csp,
-- ordered by created_at DESC): lets the scan walk this index instead of the
-- whole articles table. The NOT EXISTS subquery is already covered by
-- localized_content's UNIQUE(article_id, lang) autoindex.
CREATE INDEX IF NOT EXISTS idx_articles_csp_created ON articles(csp, created_at DESC);
-- Pending-review sweep (localized_content by lang where reviewed_at IS NULL,
-- ordered by created_at DESC).
CREATE INDEX IF NOT EXISTS idx_lc_lang_reviewed_created ON localized_content(lang, reviewed_at, created_at DESC);

CREATE TABLE IF NOT EXISTS translation_job_state (
  article_id INTEGER NOT NULL,
  lang TEXT NOT NULL,
  reason TEXT,
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (article_id, lang)
);

CREATE INDEX IF NOT EXISTS idx_translation_job_state_updated_at
ON translation_job_state(updated_at);

-- Durable gate decisions for already-translated Korean cards. translation_job_state
-- is wiped after a few minutes, so it cannot remember a skip or a failed refresh.
CREATE TABLE IF NOT EXISTS quality_refresh_check (
  article_id INTEGER NOT NULL,
  lang TEXT NOT NULL,
  rule TEXT NOT NULL,
  decision TEXT NOT NULL,
  reasons TEXT NOT NULL DEFAULT '',
  checked_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (article_id, lang)
);
