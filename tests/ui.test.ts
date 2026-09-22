import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const app = fs.readFileSync("public/app.js", "utf8");
const lines = app.split(/\r?\n/);

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
    "data-backup-volume",
    "data-project-db-backup",
    "data-project-db-delete",
    "data-cron-log",
    "data-test-backup",
    "data-restore-db",
    "data-restore-volume",
    "data-resolve-alert"
  ];

  for (const name of actionGroups) {
    const handlers = lines.filter((line) => line.includes(`[${name}]`) && line.includes(".forEach"));
    for (const line of handlers) {
      assert.match(
        line.trim(),
        /^\$\$\(/,
        `${name} group handler must begin with $$(), got: ${line.trim()}`
      );
    }
  }
});

test("dashboard contains no inline style attributes under strict CSP", () => {
  assert.equal(/style\s*=/.test(app), false);
});
