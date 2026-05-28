import type { Pool, QueryResultRow } from "pg";

/**
 * Minimal query surface shared by `pg.Pool` and PGlite (smoke / black-box path).
 * Full catalog UI, watcher, and outbox processors remain SQLite-bound (Preview).
 */
export type PostgresQueryable = {
  query: <T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ) => Promise<{ rows: T[] }>;
};

export type PostgresPoolLike = PostgresQueryable & {
  connect(): Promise<
    PostgresQueryable & {
      release(): void;
    }
  >;
  end(): Promise<void>;
};

/**
 * Duck-typed Pool for PGlite so `migratePostgresToLatest` and repos share one surface.
 */
export function wrapPgliteAsPool(db: {
  query: (
    text: string,
    params?: unknown[],
  ) => Promise<{ rows: QueryResultRow[] }>;
  close: () => Promise<void>;
}): PostgresPoolLike {
  return {
    async query<T extends QueryResultRow = QueryResultRow>(
      text: string,
      values?: unknown[],
    ) {
      const result = await db.query(text, values ?? []);
      return { rows: result.rows as T[] };
    },
    async connect() {
      return {
        query: async <T extends QueryResultRow = QueryResultRow>(
          text: string,
          values?: unknown[],
        ) => {
          const result = await db.query(text, values ?? []);
          return { rows: result.rows as T[] };
        },
        release() {
          // PGlite is single-connection; nothing to release.
        },
      };
    },
    async end() {
      await db.close();
    },
  };
}

export function asPostgresQueryable(
  pool: Pool | PostgresPoolLike,
): PostgresQueryable {
  return {
    query: <T extends QueryResultRow = QueryResultRow>(
      text: string,
      values?: unknown[],
    ) => (pool as PostgresPoolLike).query<T>(text, values),
  };
}
