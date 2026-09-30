import { Client, send } from "mystery-sdk";
import { string } from "zod";

/** @perm env(MODE) */
export async function notify() {
  await send("a");
  await send("b");
  new Client().run();
  return string();
}
