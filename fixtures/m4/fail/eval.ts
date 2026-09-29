/** @perm net */
export function run(code: string) {
  eval(code); // expect: error PERM004 unverifiable
  new Function("return process.env")(); // expect: error PERM004 unverifiable
  setTimeout("fetch('https://x.example/')" as unknown as () => void, 10); // expect: error PERM004 unverifiable
}
