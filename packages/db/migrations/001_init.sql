CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  imap_host text NOT NULL,
  imap_user text NOT NULL,
  imap_pass_enc bytea NOT NULL,
  imap_port int NOT NULL DEFAULT 993,
  imap_tls boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name text NOT NULL,
  uidvalidity bigint,
  last_uid bigint NOT NULL DEFAULT 0,
  uidnext bigint,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id, name)
);

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  folder_id uuid NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  uid bigint NOT NULL,
  internal_date timestamptz,
  msg_date timestamptz,
  from_addr text,
  to_addrs text,
  subject text,
  message_id text,
  in_reply_to text,
  references text,
  flags text[] NOT NULL DEFAULT '{}',
  size int,
  snippet text,
  body_text text,
  raw_mime text,
  thread_key text,
  fts tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(subject, '') || ' ' || coalesce(from_addr, '') || ' ' || coalesce(to_addrs, '') || ' ' || coalesce(snippet, '') || ' ' || coalesce(body_text, ''))
  ) STORED,
  UNIQUE(account_id, folder_id, uid)
);

CREATE INDEX IF NOT EXISTS idx_messages_account_date ON messages(account_id, msg_date DESC);
CREATE INDEX IF NOT EXISTS idx_messages_fts ON messages USING GIN(fts);
CREATE INDEX IF NOT EXISTS idx_messages_account_thread_key ON messages(account_id, thread_key);

CREATE TABLE IF NOT EXISTS schema_migrations (
  id serial PRIMARY KEY,
  filename text NOT NULL UNIQUE,
  applied_at timestamptz NOT NULL DEFAULT now()
);
