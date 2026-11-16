-- One phone number can belong to more than one customer (family members, a shared shop phone).
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_phone_key;
CREATE INDEX IF NOT EXISTS customers_phone ON customers (phone);
