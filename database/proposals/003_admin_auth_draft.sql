-- PROPOSTA 003: executar APENAS em banco descartável e vazio no teste CI.
-- Nunca aplicar automaticamente em banco da VPS.
BEGIN;
ALTER TABLE cms_users
  ADD COLUMN enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN auth_version BIGINT NOT NULL DEFAULT 0
    CONSTRAINT cms_auth_version_valid CHECK (auth_version >= 0 AND auth_version < 9007199254740991);

CREATE TABLE cms_admin_sessions (
  token_hash TEXT PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  csrf_hash TEXT NOT NULL CHECK (csrf_hash ~ '^[a-f0-9]{64}$'),
  user_id UUID NOT NULL REFERENCES cms_users(id) ON DELETE CASCADE,
  auth_version BIGINT NOT NULL CHECK (auth_version >= 0),
  expires_at_ms BIGINT NOT NULL,
  idle_expires_at_ms BIGINT NOT NULL,
  revoked_at_ms BIGINT,
  CONSTRAINT cms_session_deadlines CHECK (
    expires_at_ms > 0 AND idle_expires_at_ms > 0 AND
    idle_expires_at_ms <= expires_at_ms AND
    (revoked_at_ms IS NULL OR revoked_at_ms >= 0)
  )
);
CREATE INDEX cms_sessions_user_idx ON cms_admin_sessions(user_id);

CREATE TABLE cms_security_outbox (
  event_id UUID PRIMARY KEY,
  event JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT cms_security_event_shape CHECK (
    event->>'schemaVersion' = '1' AND
    event->>'eventId' = event_id::text
  )
);

CREATE TABLE cms_security_operations (
  operation_id UUID PRIMARY KEY,
  fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE cms_login_attempts (
  scope TEXT NOT NULL CHECK (scope IN ('email', 'network')),
  digest TEXT NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  window_start_ms BIGINT NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts > 0),
  PRIMARY KEY (scope, digest)
);
COMMIT;
