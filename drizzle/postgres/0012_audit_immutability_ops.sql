-- Immutable audit: security-sensitive and contract-changing events must not be rewritten.
-- Agency audit triggers omitted: Community does not create agency_audit_events (see 0011).

CREATE OR REPLACE FUNCTION quorum_forbid_audit_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% are immutable', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS incident_audit_events_immutable_update ON incident_audit_events;
--> statement-breakpoint
DROP TRIGGER IF EXISTS incident_audit_events_immutable_delete ON incident_audit_events;
--> statement-breakpoint
CREATE TRIGGER incident_audit_events_immutable_update
BEFORE UPDATE ON incident_audit_events
FOR EACH ROW EXECUTE FUNCTION quorum_forbid_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER incident_audit_events_immutable_delete
BEFORE DELETE ON incident_audit_events
FOR EACH ROW EXECUTE FUNCTION quorum_forbid_audit_mutation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS reconciliation_audit_events_immutable_update ON reconciliation_audit_events;
--> statement-breakpoint
DROP TRIGGER IF EXISTS reconciliation_audit_events_immutable_delete ON reconciliation_audit_events;
--> statement-breakpoint
CREATE TRIGGER reconciliation_audit_events_immutable_update
BEFORE UPDATE ON reconciliation_audit_events
FOR EACH ROW EXECUTE FUNCTION quorum_forbid_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER reconciliation_audit_events_immutable_delete
BEFORE DELETE ON reconciliation_audit_events
FOR EACH ROW EXECUTE FUNCTION quorum_forbid_audit_mutation();
