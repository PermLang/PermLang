import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/** @perm db.read(lead), db.write(lead) */
export async function upsertLead(email: string) {
  const existing = await prisma.lead.findUnique({ where: { email } });
  return existing ?? prisma.lead.create({ data: { email } });
}

/** @perm db.write(lead) */
export async function rename(id: string, name: string) {
  return prisma.$transaction(async (tx) => tx.lead.update({ where: { id }, data: { name } }));
}
