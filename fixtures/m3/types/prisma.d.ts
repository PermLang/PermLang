// Minimal stand-in for a generated Prisma client (node_modules/.prisma/client).
// Model delegates are interfaces named <Model>Delegate, as Prisma generates them.
declare module "@prisma/client" {
  export namespace Prisma {
    interface LeadDelegate {
      findMany(args?: object): Promise<unknown[]>;
      findUnique(args: object): Promise<unknown>;
      count(args?: object): Promise<number>;
      create(args: object): Promise<unknown>;
      update(args: object): Promise<unknown>;
      delete(args: object): Promise<unknown>;
    }
    interface UserProfileDelegate {
      findFirst(args?: object): Promise<unknown>;
      upsert(args: object): Promise<unknown>;
    }
  }
  export class PrismaClient {
    get lead(): Prisma.LeadDelegate;
    get userProfile(): Prisma.UserProfileDelegate;
    $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
    $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
    $transaction<R>(fn: (tx: Omit<PrismaClient, "$transaction">) => Promise<R>): Promise<R>;
  }
}
