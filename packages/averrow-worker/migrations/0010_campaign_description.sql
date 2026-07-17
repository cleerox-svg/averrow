-- Add description column to campaigns for storing technical IDs
-- when AI-generated names replace them
-- Column already exists in production (added inline), so this is a no-op.
-- Using a safe SELECT statement to avoid "duplicate column" errors.
SELECT 1;
