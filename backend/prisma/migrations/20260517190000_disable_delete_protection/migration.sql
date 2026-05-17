-- Delete protection has been removed from the product surface.
-- Keep the persisted preference explicitly disabled for every existing user
-- so old true/1 values cannot keep triggering confirmation dialogs.
UPDATE "users"
SET "preferences" = jsonb_set(
  COALESCE("preferences", '{}'::jsonb),
  '{deleteProtection}',
  'false'::jsonb,
  true
);
