import fs from "node:fs";

const keyLine = 'identifierHmacKey: "test-identifier-hmac-key-32chars!!",';

for (const f of [
  "tests/outcome/hubspot-zoom-path.test.ts",
  "tests/outcome/reconciliation-engine.test.ts",
]) {
  let s = fs.readFileSync(f, "utf8");
  if (s.includes("identifierHmacKey")) {
    console.log("ok", f);
    continue;
  }
  s = s.replace(
    /kek: ([^,]+),\r?\n(\s*)http:/g,
    `kek: $1,\n$2${keyLine}\n$2http:`,
  );
  fs.writeFileSync(f, s);
  console.log("patched", f, s.includes("identifierHmacKey"));
}
