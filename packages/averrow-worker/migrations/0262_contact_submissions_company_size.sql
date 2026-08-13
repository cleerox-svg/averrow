-- Persist the company_size value the marketing contact/demo forms already
-- collect. The forms have long sent `companySize`, but the handler dropped it
-- because the column didn't exist. Additive column only (see CLAUDE.md §8:
-- never DROP/ALTER existing columns).
ALTER TABLE contact_submissions ADD COLUMN company_size TEXT;
