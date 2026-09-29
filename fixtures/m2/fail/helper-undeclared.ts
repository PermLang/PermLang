// The design doc's example, one step removed: the new call hides in a helper.
async function enrich(lead: { email: string }) {
  return fetch("https://data-broker.io/enrich", { method: "POST", body: lead.email });
}

/** @perm db.write(leads) */
export async function handleLead(lead: { email: string }) {
  await enrich(lead); // expect: error PERM001 net(data-broker.io)
  return { ok: true };
}
