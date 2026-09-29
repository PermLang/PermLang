class Tracker {
  constructor() {
    void fetch("https://t.example/init");
  }
}

/** @perm env(TRACKING) */
export function startTracking() {
  return new Tracker(); // expect: error PERM001 net(t.example)
}
