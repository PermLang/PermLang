import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { builtinAdapterPaths, loadAdapters, parseManifest } from "../src/adapters.js";

const valid = {
  permlang: 1,
  package: "@acme/sms",
  defines: ["sms.send"],
  functions: { sendSms: ["sms.send({arg:0})"] },
};

describe("adapter manifests", () => {
  it("accepts a valid manifest", () => {
    const { manifest, errors } = parseManifest(valid, "acme.json");
    expect(errors).toEqual([]);
    expect(manifest?.defines).toEqual(["sms.send"]);
  });

  it.each([
    [{ ...valid, permlang: 2 }, /unsupported manifest version/],
    [{ ...valid, package: "" }, /package/],
    [{ ...valid, defines: ["net"] }, /redefines built-in capability "net"/],
    [{ ...valid, defines: ["Sms Send"] }, /invalid capability name/],
    [{ ...valid, functions: { sendSms: ["sms.snd"] } }, /unknown capability "sms.snd"/],
    [{ ...valid, functions: { sendSms: ["sms.send({host:x})"] } }, /placeholder/],
    [{ ...valid, functions: { sendSms: ["net(*)"] } }, /wildcards/],
    [{ ...valid, functions: { sendSms: "sms.send" } }, /must be an array/],
    [{ ...valid, extra: true }, /unknown field "extra"/],
  ])("rejects %j", (raw, reason) => {
    const { errors } = parseManifest(raw, "bad.json");
    expect(errors.join("\n")).toMatch(reason);
  });

  it("ships built-in adapters that all validate", () => {
    const dir = fileURLToPath(new URL("../adapters", import.meta.url));
    expect(builtinAdapterPaths().length).toBe(readdirSync(dir).filter((f) => f.endsWith(".json")).length);
    const { errors, adapters } = loadAdapters([]);
    expect(errors).toEqual([]);
    expect(adapters.map((a) => a.package)).toEqual(
      expect.arrayContaining(["axios", "stripe", "nodemailer", "child_process", "http", "https"]),
    );
  });
});
