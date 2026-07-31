# Beta demo kit

Short materials for Quorum Community design partners.

## Lifecycle screenshot

One composition of the polling silent-absence path:

**Healthy → Missing → Incident → Recovered**

![Healthy → Missing → Incident → Recovered](../screenshots/lifecycle.png)

- Source HTML: [lifecycle.html](lifecycle.html)
- Regenerate PNG: `node scripts/render-lifecycle-screenshot.mjs`

Product labels in the cards match Catalog: **Healthy**, **No recent execution**, **Overdue** (silent-absence incident), then **Healthy** again. Walkthrough uses no alert channel, matching the automated recovery test.

## Push versus polling

[docs/push-vs-polling.md](../push-vs-polling.md) — when to use each path.

## Real tested workflow example

[Poll invoices](poll-invoices-example.md) — polling contract through silence and recovery.

## Beta feedback

Use the GitHub issue template **Beta feedback** (`.github/ISSUE_TEMPLATE/beta-feedback.yml`) when filing design-partner notes.
