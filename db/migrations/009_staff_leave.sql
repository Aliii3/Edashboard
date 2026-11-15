-- Employee details: national ID, hire date, weekly days off (0 = Sunday … 6 = Saturday) and yearly leave allowance.
ALTER TABLE employees ADD COLUMN national_id text;
ALTER TABLE employees ADD COLUMN hire_date date;
ALTER TABLE employees ADD COLUMN weekly_off jsonb NOT NULL DEFAULT '[]';
ALTER TABLE employees ADD COLUMN annual_leave int NOT NULL DEFAULT 21 CHECK (annual_leave BETWEEN 0 AND 60);
-- Leave requested by an employee (or entered for them) and decided by the office.
CREATE TABLE leave_requests ("_seq" bigserial, id text PRIMARY KEY, employee_id text NOT NULL REFERENCES employees(id) DEFERRABLE INITIALLY DEFERRED, "from" date NOT NULL, "to" date NOT NULL, days int NOT NULL CHECK (days > 0), type text NOT NULL CHECK (type IN ('Annual','Sick','Unpaid')), reason text, status text NOT NULL CHECK (status IN ('Pending','Approved','Rejected')), at timestamptz NOT NULL, "by" text, decided_at timestamptz, decided_by text, CHECK ("to" >= "from"));
CREATE INDEX leave_requests_seq ON leave_requests ("_seq"); CREATE INDEX ON leave_requests (employee_id);
-- Employee logins: an employee sees only their own page and asks for leave.
ALTER TABLE users ADD COLUMN employee_id text;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('owner','operations','warehouse','finance','driver','employee'));
ALTER TABLE users ADD CONSTRAINT users_employee_link CHECK (role <> 'employee' OR employee_id IS NOT NULL);
-- ID card and other document photos. Kept out of the workspace records: files are large and owner-only.
CREATE TABLE employee_files (id bigserial PRIMARY KEY, employee_id text NOT NULL, kind text NOT NULL CHECK (kind IN ('ID','Document')), name text NOT NULL, mime text NOT NULL, size int NOT NULL, data bytea NOT NULL, at timestamptz NOT NULL DEFAULT now(), "by" text);
CREATE INDEX ON employee_files (employee_id);
