// Fixed values given to writing functions as a source rather than the target, a function of the
// project's own that happens to be named `assign`, a method that only reads its object, and a
// namespace that's only read.
const SOURCE = { url: "https://good.example/x" } as const;
const READER = {
  url: "https://good.example/x",
  get() {
    return this.url;
  },
} as const;
namespace Api {
  export const url = "https://good.example/x";
}

function assign(target: object, source: object) {
  return { ...target, ...source };
}

export function copy() {
  return [
    Object.assign({}, SOURCE),
    Object.assign.call(null, {}, SOURCE),
    Reflect.apply(Object.assign, null, [{}, SOURCE]),
    assign(SOURCE, {}),
    Object.freeze(SOURCE),
    Object.keys(Api),
    READER.get(),
  ];
}

/** @perm net(good.example) */
export function use() {
  return [fetch(SOURCE.url), fetch(READER.url), fetch(Api.url)];
}
