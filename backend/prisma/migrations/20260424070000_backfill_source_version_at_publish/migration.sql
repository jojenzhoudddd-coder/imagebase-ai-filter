-- Backfill: demos that were published BEFORE sourceVersionAtPublish existed
-- have NULL there. Without a backfill, the FE's conservative `null → false`
-- guard means their "has unpublished changes" indicator never lights up,
-- and users can't reach the Republish button from the popover.
--
-- Strategy: set it to 0 for any currently-published row that's missing the
-- stamp. This guarantees any nonzero source version (i.e. any demo that's
-- ever had a file written — which is all published demos by definition
-- since publish requires a successful build) compares as "drifted" and
-- shows the indicator once. User clicks Republish → confirmPublish writes
-- the current version to sourceVersionAtPublish → from then on the compare
-- is exact.
--
-- Accepted tradeoff: one-shot false positive on a legacy demo that was
-- published and never touched again. Cost: one extra Republish click.
UPDATE "demos"
SET "sourceVersionAtPublish" = 0
WHERE "publishSlug" IS NOT NULL
  AND "sourceVersionAtPublish" IS NULL;
