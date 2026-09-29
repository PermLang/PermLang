async function fetchOne(id: string) {
  return fetch(`https://api.github.com/repos/${id}`);
}

/** @perm net(api.github.com) */
export async function fetchAll(ids: string[]) {
  return Promise.all(ids.map(fetchOne));
}
