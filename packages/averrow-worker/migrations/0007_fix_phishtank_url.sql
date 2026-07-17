-- Fix PhishTank source_url: use HTTP (not HTTPS) to avoid 403 redirect
UPDATE feed_configs
SET source_url = 'http://data.phishtank.com/data/online-valid.json'
WHERE feed_name = 'phishtank';
