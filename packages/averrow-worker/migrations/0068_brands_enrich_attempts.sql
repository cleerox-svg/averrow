-- Track enrichment attempt counts so failed enrichment doesn't get
-- silently marked as "complete". When ipapi/ipinfo/Haiku/RDAP fail
-- transiently, we increment attempt counters and retry on the next
-- cron tick. After 5 attempts the row is skipped to avoid an infinite
-- loop on permanently broken brands.
ALTER TABLE brands ADD COLUMN enrich_attempts INTEGER DEFAULT 0;
ALTER TABLE brands ADD COLUMN sector_attempts INTEGER DEFAULT 0;
