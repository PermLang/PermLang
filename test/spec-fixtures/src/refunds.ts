import { PrismaClient } from "@prisma/client";
import * as nodemailer from "nodemailer";

const prisma = new PrismaClient();
const mail = nodemailer.createTransport({ host: "smtp.example.com" });

export async function processRefund(orderId: string, reason: string) {
  const order = await prisma.orders.findUnique({ where: { id: orderId } });
  await prisma.refunds.create({ data: { orderId, reason } });
  await mail.sendMail({ to: "customer@example.com", subject: "Refunded" });
  return order;
}

// Declared as email only, but it also calls an analytics service.
export async function notifyTeam(message: string) {
  await fetch("https://analytics.example/track", { method: "POST", body: message });
}
