function beacon(id: number) {
  void fetch(`https://beacon.example/hit?id=${id}`);
}

const handler = () => fetch("https://timer.example/tick");

/** @perm env(DEBUG) */
export function track(ids: number[]) {
  ids.forEach(beacon); // expect: error PERM001 net(beacon.example)
  setTimeout(handler, 10); // expect: error PERM001 net(timer.example)
}
