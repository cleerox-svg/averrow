-- 0282_nrd_hagezi_source.sql
--
-- nrd_hagezi switches source from the WhoisDS free daily ZIP to Hagezi's NRD
-- 7-day list (feeds/nrd_hagezi.ts). WhoisDS's free tier turned out to be a
-- uniform random 70K-domain sample per day (prod nrd_domains held exactly
-- 69,999 / 70,000 rows for 2026-10-04 / 2026-10-03); the Hagezi list
-- (GPL-3.0, data from Stamus Labs) carries ~443K domains/day and contained
-- every domain of a 108-row random sample of the WhoisDS rows.
--
-- Metadata only: the feed module fetches its URL from a constant
-- (NRD_HAGEZI_URL), so this keeps the admin Feeds page truthful rather than
-- steering runtime behaviour. No schema change; schedule_cron and enabled
-- are deliberately left as they are in prod. Idempotent.

UPDATE feed_configs
   SET source_url  = 'https://raw.githubusercontent.com/hagezi/nrd/main/domains/nrd7.txt',
       description = 'Hagezi NRD 7-day list (Stamus Labs data, GPL-3.0), streamed and diffed against the previous run''s snapshot so only newly listed domains are stored in nrd_domains and matched against monitored brands for typosquatting',
       updated_at  = datetime('now')
 WHERE feed_name = 'nrd_hagezi';
