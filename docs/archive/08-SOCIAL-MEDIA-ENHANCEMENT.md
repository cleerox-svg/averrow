> Archived 2026-06-10: roadmap item substantially shipped — instagram/reddit/telegram coverage live; current doc is docs/SOCIAL_MONITORING.md.

# Enhanced Social Media Monitoring

## Current State
- Platforms: TikTok, YouTube, GitHub, LinkedIn
- 65 alerts, all social_impersonation HIGH
- Gap: no mention monitoring, no sentiment, no Instagram/Facebook/Reddit

## Phase 1 — Better Detection on Existing Platforms
- Follower count analysis (fake = sudden spikes)
- Content similarity (bio/posts vs official brand)
- Account age (<30 days + brand impersonation = HIGH)
- Cross-platform correlation (3+ platforms = coordinated)
- Verified badge abuse detection

## Phase 2 — New Platforms
| Platform | Method | Data |
|----------|--------|------|
| Instagram | Apify scraper | Profiles, followers, bio |
| Reddit | Reddit API v2 (free) | Posts, comments |
| X/Twitter | Twitter API v2 | Handles, tweets |
| Telegram | Bot API | Public channels |

## Phase 3 — Social Intelligence Agent (new)
- Brand mention monitoring (not just impersonation)
- Sentiment analysis (positive/negative/neutral)
- Coordinated inauthentic behavior detection
- Share of voice tracking
- Weekly social intelligence briefing

## New Table
```sql
CREATE TABLE social_mentions (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  post_url TEXT,
  author_handle TEXT,
  content_preview TEXT,
  sentiment TEXT,
  mention_type TEXT,
  confidence REAL,
  detected_at TEXT DEFAULT datetime('now')
);
```
