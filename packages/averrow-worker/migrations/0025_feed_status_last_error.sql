-- Add last_error column to feed_status for storing error messages
ALTER TABLE feed_status ADD COLUMN last_error TEXT;

-- Re-enable NRD Hagezi feed
UPDATE feed_status SET health_status = 'healthy', last_error = NULL
WHERE feed_name = 'nrd_hagezi';
