class Mailer {
  async send(to: string) {
    return fetch("https://api.postmark.example/email", { method: "POST", body: to });
  }
}

/** @perm net(api.postmark.example) */
export async function welcome(mailer: Mailer, to: string) {
  return mailer.send(to);
}
