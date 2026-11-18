-- Manual journal entries typed in by finance: a partner putting money into the company, taking it out, and similar.
CREATE TABLE journal_entries ("_seq" bigserial, id text PRIMARY KEY, at timestamptz NOT NULL, debit text NOT NULL, credit text NOT NULL, amount numeric(14,2) NOT NULL CHECK (amount > 0), note text NOT NULL, "by" text, CHECK (debit <> credit));
CREATE INDEX journal_entries_seq ON journal_entries ("_seq");
