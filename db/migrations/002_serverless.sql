-- Serverless support: a change log for incremental sync, and login throttling stored in the database.
ALTER TABLE workspace ADD COLUMN changes_floor bigint NOT NULL DEFAULT 0;
CREATE TABLE changes (version bigint NOT NULL, ord int NOT NULL, t text NOT NULL, row_id text NOT NULL, op text NOT NULL CHECK (op IN ('upsert','delete','resync')), PRIMARY KEY (version, ord));
CREATE TABLE login_attempts (id bigserial PRIMARY KEY, email text NOT NULL, ip text, at timestamptz NOT NULL DEFAULT now());
CREATE INDEX ON login_attempts (email, at); CREATE INDEX ON login_attempts (ip, at);
-- Fast stock baselines: only lines that still hold a reservation.
CREATE INDEX lines_reserved_by_sku ON lines (sku) WHERE reserved > 0;
