-- Disable PhishStats (CSV 404, API 522 — service appears permanently down)
UPDATE feed_configs SET enabled = 0 WHERE feed_name = 'phishstats';
UPDATE feed_status SET health_status = 'disabled' WHERE feed_name = 'phishstats';

-- Disable NRD Hagezi — all external NRD lists exceed jsdelivr/GitHub size limits
-- Typosquatting detection is now handled by CT Logs feed (certstream) which checks
-- newly issued certificates against monitored brands in real-time
UPDATE feed_configs SET enabled = 0 WHERE feed_name = 'nrd_hagezi';
UPDATE feed_status SET health_status = 'disabled' WHERE feed_name = 'nrd_hagezi';
