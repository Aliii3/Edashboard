-- Ready-made products bought for resale: their purchase cost per unit, instead of a bill of materials.
ALTER TABLE boms ADD COLUMN buy_cost numeric(14,2) NOT NULL DEFAULT 0 CHECK (buy_cost >= 0);
-- A closed campaign keeps its history but is no longer offered on order forms.
ALTER TABLE campaigns ADD COLUMN closed boolean NOT NULL DEFAULT false;
