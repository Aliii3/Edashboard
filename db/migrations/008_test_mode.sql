-- "Test from scratch": the real records are set aside here while the workspace runs empty.
CREATE TABLE test_mode (id int PRIMARY KEY CHECK (id = 1), data jsonb NOT NULL, started_at timestamptz NOT NULL DEFAULT now(), started_by text);
