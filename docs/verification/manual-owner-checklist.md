# Manual owner checklist

Only checks that need a human or private credentials. Automated gates are elsewhere (`npm run verify:self-hosted`, `npm run test:e2e:n8n:real`).

1. Can a new user complete first setup (setup token → admin → Protect a client) without help?
2. Is creating and explicitly activating a contract clear (no silent activation)?
3. Are Healthy, Overdue, Incident, and Evidence Level understandable on `/catalog`?
4. Does a real Slack webhook or SMTP alert reach the intended device? (Use env credentials locally; never commit them.)
5. Is the alert message useful (contract name, incident type, next action)?
6. Does the UI explain that heartbeat evidence does not prove destination delivery?
7. Does Quorum run 24–48 hours without false or duplicate alerts? (Use soak scripts in `docs/verification/manual-soak-test.md`.)
8. Would you be comfortable installing this for a design partner with the published limitations?

Pass/fail is the owner's judgment. Do not treat this list as automated CI.
