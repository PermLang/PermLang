// Minimal stand-in for a Prisma client after `$extends(...)`. Found in the Umami trial:
// extended clients type every model through generic runtime types, so the model's
// name only appears at the call site (`client.user.findMany`), not in the declaration.
declare module "@prisma/client/extension" {
  type DynamicModel<Name extends string> = Name extends string
    ? {
        findMany(args?: object): Promise<unknown[]>;
        findUnique(args: object): Promise<unknown>;
        create(args: object): Promise<unknown>;
        delete(args: object): Promise<unknown>;
      }
    : never;
  export interface ExtendedClient {
    user: DynamicModel<"user">;
    teamUser: DynamicModel<"teamUser">;
    $queryRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
  }
  export function extendedClient(): ExtendedClient;
}
