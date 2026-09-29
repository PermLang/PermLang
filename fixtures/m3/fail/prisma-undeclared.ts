import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/** @perm db.read(lead) */
export async function cleanup(id: string) {
  await prisma.lead.delete({ where: { id } }); // expect: error PERM001 db.write(lead)
  await prisma.userProfile.findFirst(); // expect: error PERM001 db.read(userProfile)
  // Raw SQL can read or write any table.
  await prisma.$executeRaw`DELETE FROM leads`; // expect: error PERM001 db.read expect: error PERM001 db.write
}
