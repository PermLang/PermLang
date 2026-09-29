// A local object that happens to be called `fs` is not Node's file system.
const fs = {
  readFileSync(path: string) {
    return `stub:${path}`;
  },
};

export function load() {
  return fs.readFileSync("/etc/passwd");
}
