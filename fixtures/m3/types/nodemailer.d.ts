// Minimal stand-in for @types/nodemailer (sendMail is declared on class Mail).
declare module "nodemailer" {
  class Mail {
    sendMail(options: object): Promise<unknown>;
    verify(): Promise<true>;
  }
  export type Transporter = Mail;
  export function createTransport(options: object): Transporter;
}
