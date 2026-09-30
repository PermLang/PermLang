import { extendedClient } from "@prisma/client/extension";

const prisma = { client: extendedClient() };

/** @perm db.read(user) */
export async function removeMember(id: string) {
  await prisma.client.user.findUnique({ where: { id } });
  await prisma.client.teamUser.findMany({ where: { userId: id } }); // expect: error PERM001 db.read(teamUser)
  await prisma.client.user.delete({ where: { id } }); // expect: error PERM001 db.write(user)
  await prisma.client.$queryRaw`SELECT 1`; // expect: error PERM001 db.read expect: error PERM001 db.write
}
