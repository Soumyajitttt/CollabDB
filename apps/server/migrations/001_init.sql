CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE documents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  owner_id    UUID NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE document_members (
  doc_id   UUID REFERENCES documents(id) ON DELETE CASCADE,
  user_id  UUID REFERENCES users(id) ON DELETE CASCADE,
  role     TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
  PRIMARY KEY (doc_id, user_id)
);
CREATE INDEX document_members_user_idx ON document_members (user_id);

-- Append-only update log
CREATE TABLE updates (
  id          BIGSERIAL PRIMARY KEY,
  doc_id      UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  seq         BIGINT NOT NULL,
  update      BYTEA NOT NULL,
  user_id     UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (doc_id, seq)
);
CREATE INDEX updates_doc_seq_idx ON updates (doc_id, seq);

-- Compaction output and version history (used from Week 3; load logic already reads it)
CREATE TABLE snapshots (
  id          BIGSERIAL PRIMARY KEY,
  doc_id      UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  state       BYTEA NOT NULL,
  up_to_seq   BIGINT NOT NULL,
  label       TEXT,
  is_auto     BOOLEAN NOT NULL DEFAULT true,
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX snapshots_doc_idx ON snapshots (doc_id, up_to_seq DESC);

-- Activity feed (used from Week 4)
CREATE TABLE activity (
  id          BIGSERIAL PRIMARY KEY,
  doc_id      UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES users(id),
  kind        TEXT NOT NULL,
  payload     JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
