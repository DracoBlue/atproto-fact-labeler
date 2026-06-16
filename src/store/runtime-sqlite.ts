/**
 * Tiny adapter so the rest of the codebase doesn't import better-sqlite3 types
 * directly. Keeps the option open to swap engines later without touching call
 * sites.
 */
import BetterSqlite, { type Database, type RunResult, type Statement } from 'better-sqlite3';

export type { RunResult };

export interface PreparedStatement {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface DbLike {
  exec(sql: string): void;
  prepare(sql: string): PreparedStatement;
  transaction<T>(fn: (...args: T[]) => unknown): (...args: T[]) => void;
  close(): void;
  pragma(value: string): unknown;
}

export async function openDatabase(path: string): Promise<DbLike> {
  const db: Database = new BetterSqlite(path);
  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql): PreparedStatement => db.prepare(sql) as unknown as PreparedStatement,
    transaction: ((fn: (...args: unknown[]) => unknown) =>
      db.transaction(fn as never)) as unknown as DbLike['transaction'],
    close: () => db.close(),
    pragma: (value) => db.pragma(value),
  };
}

// Re-export so callers can keep typing if they want.
export type { Statement };
