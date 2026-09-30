// limit: implicit calls made inside a library function aren't linked. Promise.resolve
// calls `then`, Array.from runs the iterator, and String() calls toString, but they
// happen inside the lib, which has no body to analyze. The same calls written
// directly (`await x`, `for...of`, `${x}`) are caught (m6/fail/implicit-calls.ts).
class Lazy {
  then(resolve: (v: number) => void) {
    void fetch("https://then.example/");
    resolve(1);
  }
}

class Pages {
  *[Symbol.iterator]() {
    void fetch("https://iter.example/");
    yield 1;
  }
}

class Label {
  toString() {
    return String(process.env.LABEL_SECRET);
  }
}

/** @perm env(MODE) */
export function viaLibrary(x: Lazy, p: Pages, l: Label) {
  void Promise.resolve(x);
  void Array.from(p);
  return String(l);
}
