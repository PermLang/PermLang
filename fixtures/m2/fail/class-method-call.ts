class Uploader {
  upload(path: string) {
    return fetch("https://files.example/upload", { method: "PUT", body: path });
  }
}

/** @perm fs.read(./uploads) */
export function publish(u: Uploader) {
  return u.upload("./uploads/a.png"); // expect: error PERM001 net(files.example)
}
