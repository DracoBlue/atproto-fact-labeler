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

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface DbLike {
  exec(sql: string): void;
  prepare(sql: string): PreparedStatement;
  /**
   * Wraps a callback in a SQLite transaction; the returned function executes it.
   * Typed with `any` because better-sqlite3's `transaction` is generic in a way
   * that doesn't survive interface erasure; callers pass concrete shapes.
   */
  transaction(fn: (...args: any[]) => unknown): (...args: any[]) => unknown;
  close(): void;
  pragma(value: string): unknown;
}

export async function openDatabase(path: string): Promise<DbLike> {
  const db: Database = new BetterSqlite(path);
  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql): PreparedStatement => db.prepare(sql) as unknown as PreparedStatement,
    transaction: (fn) => db.transaction(fn),
    close: () => db.close(),
    pragma: (value) => db.pragma(value),
  };
}

// Re-export so callers can keep typing if they want.
export type { Statement };
