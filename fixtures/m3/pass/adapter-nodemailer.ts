import * as nodemailer from "nodemailer";

const transport = nodemailer.createTransport({ host: "smtp.example.com" });

/** @perm email.send */
export function welcome(to: string) {
  return transport.sendMail({ to, subject: "Welcome" });
}
