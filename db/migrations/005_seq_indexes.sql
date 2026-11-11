-- The first load pages through each table in insertion order; these indexes keep that fast at scale.
CREATE INDEX IF NOT EXISTS skus_seq ON skus ("_seq"); CREATE INDEX IF NOT EXISTS materials_seq ON materials ("_seq"); CREATE INDEX IF NOT EXISTS boms_seq ON boms ("_seq");
CREATE INDEX IF NOT EXISTS customers_seq ON customers ("_seq"); CREATE INDEX IF NOT EXISTS contacts_seq ON contacts ("_seq"); CREATE INDEX IF NOT EXISTS couriers_seq ON couriers ("_seq");
CREATE INDEX IF NOT EXISTS drivers_seq ON drivers ("_seq"); CREATE INDEX IF NOT EXISTS campaigns_seq ON campaigns ("_seq"); CREATE INDEX IF NOT EXISTS spend_seq ON spend ("_seq");
CREATE INDEX IF NOT EXISTS orders_seq ON orders ("_seq"); CREATE INDEX IF NOT EXISTS lines_seq ON lines ("_seq"); CREATE INDEX IF NOT EXISTS deliveries_seq ON deliveries ("_seq");
CREATE INDEX IF NOT EXISTS payments_seq ON payments ("_seq"); CREATE INDEX IF NOT EXISTS handovers_seq ON handovers ("_seq"); CREATE INDEX IF NOT EXISTS handover_allocs_seq ON handover_allocs ("_seq");
CREATE INDEX IF NOT EXISTS settlements_seq ON settlements ("_seq"); CREATE INDEX IF NOT EXISTS settlement_allocs_seq ON settlement_allocs ("_seq"); CREATE INDEX IF NOT EXISTS driver_expenses_seq ON driver_expenses ("_seq");
CREATE INDEX IF NOT EXISTS discrepancies_seq ON discrepancies ("_seq"); CREATE INDEX IF NOT EXISTS cases_seq ON cases ("_seq"); CREATE INDEX IF NOT EXISTS movements_seq ON movements ("_seq");
CREATE INDEX IF NOT EXISTS production_seq ON production ("_seq"); CREATE INDEX IF NOT EXISTS expenses_seq ON expenses ("_seq"); CREATE INDEX IF NOT EXISTS events_seq ON events ("_seq");
