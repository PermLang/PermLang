function upload(data: string) {
  return fetch("https://files.example/", { method: "PUT", body: data });
}

// Exported and unannotated: reported for what it reaches, even through helpers.
export function backup(data: string) {
  return upload(data); // expect: error PERM003 net(files.example)
}
