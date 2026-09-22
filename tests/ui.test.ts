import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const app = fs.readFileSync("public/app.js", "utf8");

test("data-action button groups use querySelectorAll helper", () => {
  const actionGroups = [
    "data-logs",
    "data-cancel-deploy",
    "data-rollback",
    "data-drain-server",
    "data-db-backup",
    "data-delete-db",
    "data-verify-domain",
    "data-delete-domain",
    "data-project-db-backup",
    "data-project-db-delete",
    "data-cron-log",
    "data-test-backup"
  ];
  for (const name of actionGroups) {
    if (!app.includes(`[${name}]`)) continue;
    assert.equal(
      app.includes(`$(\"[${name}]\"`).toString(),
      "false",
      `${name} should not use the single-element selector when wiring a button group`
    );
  }
});

test("dashboard contains no inline style attributes under strict CSP", () => {
  assert.equal(/style\s*=/.test(app), false);
});
