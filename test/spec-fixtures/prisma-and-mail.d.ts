// Stand-ins for the fixture's libraries. The file name contains "prisma", as a real
// generated client's path does, which is how Prisma's typings are recognized.
declare module "@prisma/client" {
  export namespace Prisma {
    interface OrdersDelegate {
      findUnique(args: object): Promise<unknown>;
    }
    interface RefundsDelegate {
      create(args: object): Promise<unknown>;
    }
  }
  export class PrismaClient {
    get orders(): Prisma.OrdersDelegate;
    get refunds(): Prisma.RefundsDelegate;
  }
}

declare module "nodemailer" {
  class Mail {
    sendMail(options: object): Promise<unknown>;
  }
  export function createTransport(options: object): Mail;
}
