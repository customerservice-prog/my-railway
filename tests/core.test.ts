import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { encryptSecret, decryptSecret } from "../src/shared/crypto.js";
import { slug, safeContainerName } from "../src/shared/util.js";

test("secret encryption round trips and is randomized", () => {
  process.env.SECRET_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
  const a = encryptSecret("stripe-secret");
  const b = encryptSecret("stripe-secret");
  assert.notEqual(a, b);
  assert.equal(decryptSecret(a), "stripe-secret");
  assert.equal(decryptSecret(b), "stripe-secret");
});

test("slug and container name remove unsafe characters", () => {
  assert.equal(slug("My Great App!"), "my-great-app");
  assert.equal(safeContainerName("MR Service/ABC"), "mr-service-abc");
});


test("service PATCH builds a bound id placeholder", () => {
  const source = fs.readFileSync("src/control/server.ts","utf8");
  assert.ok(source.includes('const idPlaceholder = "$" + values.length;'));
  assert.equal(source.includes('const idPlaceholder = `${values.length}`;'), false);
});
