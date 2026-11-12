-- In-store counter sales are recorded as a delivery handed over at the store, with no carrier.
ALTER TABLE deliveries DROP CONSTRAINT IF EXISTS deliveries_mode_check;
ALTER TABLE deliveries ADD CONSTRAINT deliveries_mode_check CHECK (mode IN ('driver','courier','store'));
CREATE INDEX IF NOT EXISTS deliveries_tracking ON deliveries (tracking) WHERE tracking IS NOT NULL AND tracking <> '';
-- Staff and daily attendance. One record per employee per day.
CREATE TABLE employees ("_seq" bigserial, id text PRIMARY KEY, name text NOT NULL, phone text, job_title text, shift_start text, active boolean NOT NULL DEFAULT true, note text, at timestamptz);
CREATE TABLE attendance ("_seq" bigserial, id text PRIMARY KEY, employee_id text NOT NULL REFERENCES employees(id) DEFERRABLE INITIALLY DEFERRED, date date NOT NULL, status text NOT NULL CHECK (status IN ('Present','Late','Absent','Leave','Day off')), check_in text, check_out text, note text, at timestamptz NOT NULL, "by" text, UNIQUE (employee_id, date));
CREATE INDEX employees_seq ON employees ("_seq"); CREATE INDEX attendance_seq ON attendance ("_seq"); CREATE INDEX ON attendance (date);
