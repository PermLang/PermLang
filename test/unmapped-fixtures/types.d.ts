// Stand-ins for third-party packages, used by test/unmapped.test.ts.
declare module "mystery-sdk" {
  export function send(message: string): Promise<void>;
  export class Client {
    run(): void;
  }
}

// Declared pure by adapters/pure.json.
declare module "zod" {
  export function string(): unknown;
}
