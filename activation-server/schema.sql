PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS codes (
  code_hash TEXT PRIMARY KEY CHECK(length(code_hash) = 64),
  edition TEXT NOT NULL CHECK(edition = 'v1'),
  max_devices INTEGER NOT NULL CHECK(max_devices BETWEEN 1 AND 2),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'revoked')),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
  code_hash TEXT NOT NULL REFERENCES codes(code_hash),
  fingerprint TEXT NOT NULL CHECK(length(fingerprint) = 64),
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  PRIMARY KEY(code_hash, fingerprint)
);
CREATE TABLE IF NOT EXISTS rate_limits (
  subject TEXT PRIMARY KEY,
  minute INTEGER NOT NULL,
  attempts INTEGER NOT NULL
);
