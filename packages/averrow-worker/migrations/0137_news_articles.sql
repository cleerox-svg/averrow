-- Migration 0137 — news_articles ingestion log.
--
-- Phase D of the Threat Actors rebuild. The news-watcher agent polls
-- a configured set of RSS feeds (CISA, Mandiant, Microsoft Threat
-- Intel, etc.) and asks Haiku to extract structured intel:
--   * Threat actor names mentioned
--   * Target countries / sectors
--   * Severity / urgency
--   * Whether the item describes geopolitical / state-sponsored activity
--
-- For each article, the extracted actors get upserted in threat_actors
-- (source='news') and high-confidence geopolitical items create or
-- update geopolitical_campaigns rows.
--
-- This table tracks the per-article ingestion log so:
--   1. We can dedup runs (don't re-pay Haiku for an article we've
--      already processed — keyed by the article URL).
--   2. We have provenance: what article said this actor was active.
--   3. We can replay extraction by clearing and re-ingesting if the
--      Haiku prompt changes.

CREATE TABLE IF NOT EXISTS news_articles (
  id              TEXT PRIMARY KEY,
  source_feed     TEXT NOT NULL,                       -- 'cisa' | 'mandiant' | 'msft_threatintel' | …
  article_url     TEXT NOT NULL UNIQUE,
  title           TEXT NOT NULL,
  excerpt         TEXT,
  published_at    TEXT,
  ingested_at     TEXT NOT NULL DEFAULT (datetime('now')),
  -- Haiku extraction output (JSON blob — looser than columns so the
  -- prompt can evolve without further migrations)
  extracted       TEXT,
  -- 'pending' | 'ok' | 'no_actors' | 'failed'
  extract_status  TEXT NOT NULL DEFAULT 'pending'
                     CHECK (extract_status IN ('pending', 'ok', 'no_actors', 'failed')),
  is_geopolitical INTEGER NOT NULL DEFAULT 0           -- bool flag from extraction
);

-- Per-source recent ingest timeline (for the Agents page diagnostic
-- and for cron-cycle counters)
CREATE INDEX IF NOT EXISTS idx_news_articles_source_ingested
  ON news_articles(source_feed, ingested_at DESC);

-- Geopolitical-only filter (the primary surface this agent feeds)
CREATE INDEX IF NOT EXISTS idx_news_articles_geopolitical
  ON news_articles(is_geopolitical, ingested_at DESC);
