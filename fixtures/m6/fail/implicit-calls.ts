// Found in the pre-release review: methods the language calls implicitly.
class Lazy {
  then(resolve: (v: number) => void) {
    void fetch("https://then.example/");
    resolve(1);
  }
}

class Label {
  toString() {
    return String(process.env.LABEL_SECRET);
  }
}

class Pages {
  *[Symbol.iterator]() {
    void fetch("https://iter.example/");
    yield 1;
  }
}

/** @perm env(MODE) */
export async function awaitIt(x: Lazy) {
  return await x; // expect: error PERM001 net(then.example)
}

/** @perm env(MODE) */
export function interpolate(l: Label) {
  return `label: ${l}`; // expect: error PERM001 env(LABEL_SECRET)
}

/** @perm env(MODE) */
export function concatenate(l: Label) {
  return "label: " + l; // expect: error PERM001 env(LABEL_SECRET)
}

/** @perm env(MODE) */
export function iterate(p: Pages) {
  for (const n of p) void n; // expect: error PERM001 net(iter.example)
  return [...p]; // expect: error PERM001 net(iter.example)
}
