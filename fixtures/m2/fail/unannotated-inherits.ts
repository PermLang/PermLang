function upload(data: string) {
  return fetch("https://files.example/", { method: "PUT", body: data });
}

// Exported and unannotated: warned about what it reaches, even through helpers.
export function backup(data: string) {
  return upload(data); // expect: warning PERM003 net(files.example)
}
