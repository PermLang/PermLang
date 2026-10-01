// Minimal stand-in for drizzle-orm, shaped like its real typings (verified against
// drizzle-orm's pg-core: PgDatabase, PgSelectBuilder, RelationalQueryBuilder, pgTable).
declare module "drizzle-orm/pg-core" {
  export interface PgTable {
    readonly _: { name: string };
  }
  export const pgTable: (name: string, columns: Record<string, unknown>) => PgTable;
  export function text(name?: string): unknown;

  // Like the real typings, joins are function-typed properties, not methods.
  type PgSelectJoinFn = (table: PgTable, on: unknown) => PgSelect;
  export class PgSelect {
    leftJoin: PgSelectJoinFn;
    innerJoin: PgSelectJoinFn;
    where(condition: unknown): PgSelect;
    then<R>(onfulfilled: (value: unknown[]) => R): Promise<R>;
  }
  export class PgSelectBuilder {
    from(table: PgTable): PgSelect;
  }
  export class PgInsertBuilder {
    values(rows: object): Promise<unknown>;
  }
  export class PgUpdateBuilder {
    set(values: object): { where(condition: unknown): Promise<unknown> };
  }
  export class RelationalQueryBuilder {
    findMany(config?: object): Promise<unknown[]>;
    findFirst(config?: object): Promise<unknown>;
  }
  export class PgDatabase {
    query: Record<string, RelationalQueryBuilder>;
    select(): PgSelectBuilder;
    insert(table: PgTable): PgInsertBuilder;
    update(table: PgTable): PgUpdateBuilder;
    delete(table: PgTable): { where(condition: unknown): Promise<unknown> };
    execute(query: unknown): Promise<unknown>;
  }
}

declare module "drizzle-orm/node-postgres" {
  import type { PgDatabase } from "drizzle-orm/pg-core";
  export function drizzle(url: string): PgDatabase;
}

declare module "drizzle-orm" {
  export function eq(left: unknown, right: unknown): unknown;
  export function sql(strings: TemplateStringsArray, ...values: unknown[]): unknown;
}
