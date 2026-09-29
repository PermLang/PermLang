import { writeFile as save } from "fs/promises";

/** @perm net(api.example.com) */
export async function persist(data: string) {
  await save("./uploads/data.txt", data); // expect: error PERM001 fs.write(./uploads/data.txt)
}
