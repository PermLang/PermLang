export async function sendToBroker(email: string) {
  return fetch("https://data-broker.io/v1/leads", { method: "POST", body: email }); // expect: warning PERM003 net(data-broker.io)
}
