-- Immutable audit: security-sensitive and contract-changing events must not be rewritten.
-- Agency audit triggers omitted: Community does not create agency_audit_events (see 0011).

CREATE TRIGGER `incident_audit_events_immutable_update`
BEFORE UPDATE ON `incident_audit_events`
BEGIN
	SELECT RAISE(ABORT, 'incident_audit_events are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `incident_audit_events_immutable_delete`
BEFORE DELETE ON `incident_audit_events`
BEGIN
	SELECT RAISE(ABORT, 'incident_audit_events are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `reconciliation_audit_events_immutable_update`
BEFORE UPDATE ON `reconciliation_audit_events`
BEGIN
	SELECT RAISE(ABORT, 'reconciliation_audit_events are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `reconciliation_audit_events_immutable_delete`
BEFORE DELETE ON `reconciliation_audit_events`
BEGIN
	SELECT RAISE(ABORT, 'reconciliation_audit_events are immutable');
END;
