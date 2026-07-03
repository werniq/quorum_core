# Test results

Captured during the self-hosted remediation verification pass (2026-07-19).

## Commands run

| Command                              | Exit | Notes                                        |
| ------------------------------------ | ---- | -------------------------------------------- |
| `npm run format:check`               | 0    | Prettier                                     |
| `npm run lint`                       | 0    | After unused-import fix in ops-audit test    |
| `npm run typecheck`                  | 0    |                                              |
| `npm test`                           | 0    | **43** files, **218** tests                  |
| `npm run test:integration`           | 0    | 5 tests                                      |
| `npm run test:repository`            | 0    | 12 tests                                     |
| `npm run test:migrations`            | 0    | 15 tests                                     |
| `npm run test:security`              | 0    | 26 tests                                     |
| `npm run test:cov`                   | 0    | See coverage below                           |
| `npm run build`                      | 0    |                                              |
| `npm run release:check`              | 0    | Includes format:check                        |
| `npm run test:restart`               | 0    | Process restart + wrong KEK                  |
| `npm run test:compose`               | 0    | Clean tree Compose black-box                 |
| `npm run test:e2e:n8n`               | 0    | Real n8n 1.95.3 + Quorum; see limitations    |
| Initial compose (Docker daemon down) | 1    | Fixed by starting Docker Desktop; not erased |

## Coverage (`npm run test:cov`)

All gated files: **98.92%** stmts / **95.68%** branch / **100%** funcs / **98.92%** lines.

## New / expanded suites

- `tests/security/ops-audit-coverage.test.ts`
- `tests/security/heartbeat-hmac-guards.test.ts`
- `tests/runtime/graceful-shutdown.test.ts`
- connector network `self_hosted_local` case
- waiting persistence assertions in outcome / migration tests
