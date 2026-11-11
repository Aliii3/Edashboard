-- Who paid the shipping on an undelivered parcel, and why it came back.
ALTER TABLE deliveries ADD COLUMN return_reason text;
ALTER TABLE deliveries ADD COLUMN shipping_paid_by text CHECK (shipping_paid_by IN ('business','waived','customer'));
ALTER TABLE deliveries ADD COLUMN fee_charged numeric(14,2) CHECK (fee_charged >= 0);
-- The campaign's ID in Meta Ads Manager, to match spend to the right campaign.
ALTER TABLE campaigns ADD COLUMN meta_id text;
