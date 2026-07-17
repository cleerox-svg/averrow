-- Trust Radar v2 — Authentication & Authorization Tables
-- users, user_brand_scopes, invitations, sessions

-- ─── Users ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  google_sub  TEXT UNIQUE,           -- Google OAuth subject ID
  email       TEXT NOT NULL,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'analyst' CHECK (role IN ('super_admin', 'admin', 'analyst', 'client')),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deactivated')),
  invited_by  TEXT REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  last_login  TEXT,
  last_active TEXT
);

CREATE UNIQUE INDEX idx_users_google_sub ON users(google_sub);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_status ON users(status);

-- ─── User Brand Scopes (Client role visibility) ────────────────
CREATE TABLE IF NOT EXISTS user_brand_scopes (
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, brand_id)
);

-- ─── Invitations ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invitations (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('super_admin', 'admin', 'analyst', 'client')),
  token_hash  TEXT NOT NULL UNIQUE,  -- SHA-256 hash of raw invite token
  invited_by  TEXT NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL,         -- 72 hours from creation
  accepted_at TEXT,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'expired', 'revoked'))
);

CREATE INDEX idx_invitations_email ON invitations(email);
CREATE INDEX idx_invitations_status ON invitations(status);
CREATE INDEX idx_invitations_token ON invitations(token_hash);

-- ─── Sessions ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash TEXT NOT NULL,   -- SHA-256 hash
  issued_at          TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at         TEXT NOT NULL,   -- 7 days from issue
  revoked_at         TEXT,
  ip_address         TEXT,
  user_agent         TEXT
);

CREATE INDEX idx_sessions_user ON sessions(user_id, expires_at);
CREATE INDEX idx_sessions_refresh ON sessions(refresh_token_hash);
