-- Allow domain `waiting` status alongside legacy `ignored`.
-- Historical rows with match_status='ignored' were in-delay waiting; convert them.
ALTER TABLE "reconciliation_items" DROP CONSTRAINT "reconciliation_items_status_check";
--> statement-breakpoint
UPDATE "reconciliation_items"
SET "match_status" = 'waiting'
WHERE "match_status" = 'ignored';
--> statement-breakpoint
ALTER TABLE "reconciliation_items" ADD CONSTRAINT "reconciliation_items_status_check"
CHECK ("match_status" IN ('matched', 'missing', 'duplicate', 'late', 'ignored', 'waiting'));
