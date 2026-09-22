import http from "node:http";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const exec = promisify(execFile);
const port = Number(process.env.UPDATER_PORT || 8090);
const token = String(process.env.PLATFORM_UPDATER_TOKEN || "");
const root = path.resolve(process.env.HOST_PROJECT_DIR || "/opt/my-railway");
const updateRef = String(process.env.PLATFORM_UPDATE_REF || "release/private-v1-rc1");
const dataDir = path.join(root, "data");
const stateFile = path.join(dataDir, "platform-update-state.json");
const logFile = path.join(dataDir, "platform-update.log");
const envFile = path.join(root, ".env");
const settingsStateFile = path.join(dataDir, "platform-settings-state.json");
const settingsLogFile = path.join(dataDir, "platform-settings.log");
const settingsPreviousEnvFile = path.join(dataDir, "platform-settings-previous.env");

if (token.length < 32) {
  console.error("PLATFORM_UPDATER_TOKEN must be configured with at least 32 characters.");
  process.exit(1);
}

await fs.mkdir(dataDir, { recursive: true });
await exec("git", ["config","--global","--add","safe.directory",root]).catch(()=>{});

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function authorized(req) {
  const supplied = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  return safeEqual(supplied, token);
}

async function readState() {
  try {
    return JSON.parse(await fs.readFile(stateFile, "utf8"));
  } catch {
    return {
      status: "idle",
      ref: updateRef,
      jobId: null,
      startedAt: null,
      finishedAt: null,
      currentSha: null,
      targetSha: null,
      error: null
    };
  }
}

async function writeState(value) {
  const temp = stateFile + ".tmp";
  await fs.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(temp, stateFile);
}

async function tailLog(maxBytes = 50_000) {
  try {
    const stat = await fs.stat(logFile);
    const start = Math.max(0, stat.size - maxBytes);
    const handle = await fs.open(logFile, "r");
    try {
      const buffer = Buffer.alloc(stat.size - start);
      await handle.read(buffer, 0, buffer.length, start);
      return buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}

const editableKeys = new Set([
  "PLATFORM_HOST",
  "PUBLIC_IP",
  "ACME_EMAIL",
  "PLATFORM_UPDATE_REF",
  "GITHUB_APP_ID",
  "GITHUB_APP_INSTALLATION_ID",
  "GITHUB_APP_PRIVATE_KEY_BASE64",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_TOKEN",
  "RESTIC_REPOSITORY",
  "RESTIC_PASSWORD",
  "ALERT_WEBHOOK_URL",
  "AUTO_BACKUPS",
  "AUTO_PREDEPLOY_BACKUPS",
  "AUTO_ROLLBACK"
]);

const secretKeys = new Set([
  "GITHUB_APP_PRIVATE_KEY_BASE64",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_TOKEN",
  "RESTIC_PASSWORD"
]);

async function readSettingsState() {
  try {
    return JSON.parse(await fs.readFile(settingsStateFile, "utf8"));
  } catch {
    return { status:"idle", jobId:null, startedAt:null, finishedAt:null, error:null };
  }
}

async function tailSettingsLog(maxBytes = 50_000) {
  try {
    const stat = await fs.stat(settingsLogFile);
    const start = Math.max(0, stat.size - maxBytes);
    const handle = await fs.open(settingsLogFile, "r");
    try {
      const buffer = Buffer.alloc(stat.size - start);
      await handle.read(buffer,0,buffer.length,start);
      return buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}

async function parseEnvFile() {
  const raw = await fs.readFile(envFile,"utf8");
  const lines = raw.split(/\r?\n/);
  const values = new Map();
  for (const line of lines) {
    if (!line || /^\s*#/.test(line)) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    values.set(line.slice(0,idx).trim(), line.slice(idx+1));
  }
  return { raw, lines, values };
}

function validateSetting(key, value) {
  if (!editableKeys.has(key)) throw new Error(`unsupported platform setting: ${key}`);
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  if (value.includes("\n") || value.includes("\r") || value.includes("\0")) {
    throw new Error(`${key} must be a single-line value`);
  }

  if (key === "PLATFORM_HOST" && value && !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(value)) {
    throw new Error("PLATFORM_HOST must be a hostname without scheme/path");
  }
  if (key === "PUBLIC_IP" && value && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) {
    throw new Error("PUBLIC_IP must be an IPv4 address");
  }
  if (key === "ACME_EMAIL" && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new Error("ACME_EMAIL must be a valid email address");
  }
  if (key === "PLATFORM_UPDATE_REF" && value && !(/^[0-9a-f]{40}$/i.test(value) || /^[A-Za-z0-9._/-]+$/.test(value))) {
    throw new Error("PLATFORM_UPDATE_REF contains unsupported characters");
  }
  if (["GITHUB_APP_ID","GITHUB_APP_INSTALLATION_ID"].includes(key) && value && !/^\d+$/.test(value)) {
    throw new Error(`${key} must contain digits only`);
  }
  if (key === "GITHUB_WEBHOOK_SECRET" && value && value.length < 32) {
    throw new Error("GITHUB_WEBHOOK_SECRET must be at least 32 characters");
  }
  if (key === "GITHUB_APP_PRIVATE_KEY_BASE64" && value) {
    const decoded = Buffer.from(value,"base64").toString("utf8");
    if (!decoded.includes("PRIVATE KEY")) throw new Error("GITHUB_APP_PRIVATE_KEY_BASE64 does not decode to a PEM private key");
  }
  if (key === "ALERT_WEBHOOK_URL" && value) {
    let parsed;
    try { parsed = new URL(value); } catch { throw new Error("ALERT_WEBHOOK_URL must be a valid URL"); }
    if (!["https:","http:"].includes(parsed.protocol)) throw new Error("ALERT_WEBHOOK_URL must use http or https");
  }
  if (["AUTO_BACKUPS","AUTO_PREDEPLOY_BACKUPS","AUTO_ROLLBACK"].includes(key) && !["true","false"].includes(value)) {
    throw new Error(`${key} must be true or false`);
  }
}

async function platformSettingsView() {
  const { values } = await parseEnvFile();
  const get = (key) => values.get(key) ?? "";
  return {
    PLATFORM_HOST:get("PLATFORM_HOST"),
    PUBLIC_IP:get("PUBLIC_IP"),
    ACME_EMAIL:get("ACME_EMAIL"),
    PLATFORM_UPDATE_REF:get("PLATFORM_UPDATE_REF"),
    GITHUB_APP_ID:get("GITHUB_APP_ID"),
    GITHUB_APP_INSTALLATION_ID:get("GITHUB_APP_INSTALLATION_ID"),
    GITHUB_APP_PRIVATE_KEY_BASE64_CONFIGURED:Boolean(get("GITHUB_APP_PRIVATE_KEY_BASE64")),
    GITHUB_WEBHOOK_SECRET_CONFIGURED:Boolean(get("GITHUB_WEBHOOK_SECRET") && get("GITHUB_WEBHOOK_SECRET") !== "replace-me"),
    GITHUB_TOKEN_CONFIGURED:Boolean(get("GITHUB_TOKEN")),
    RESTIC_REPOSITORY:get("RESTIC_REPOSITORY"),
    RESTIC_PASSWORD_CONFIGURED:Boolean(get("RESTIC_PASSWORD")),
    ALERT_WEBHOOK_URL:get("ALERT_WEBHOOK_URL"),
    AUTO_BACKUPS:(get("AUTO_BACKUPS") || "true") === "true",
    AUTO_PREDEPLOY_BACKUPS:(get("AUTO_PREDEPLOY_BACKUPS") || "true") === "true",
    AUTO_ROLLBACK:(get("AUTO_ROLLBACK") || "false") === "true"
  };
}

async function writePlatformSettings(input) {
  const settings = input?.settings && typeof input.settings === "object" ? input.settings : {};
  const clearKeys = Array.isArray(input?.clearKeys) ? input.clearKeys : [];

  for (const key of clearKeys) {
    if (!editableKeys.has(String(key))) throw new Error(`unsupported clear key: ${key}`);
  }

  const updates = new Map();
  for (const [key, raw] of Object.entries(settings)) {
    if (raw === undefined || raw === null || raw === "") {
      // Blank secret fields mean "leave unchanged"; blank non-secrets explicitly clear.
      if (secretKeys.has(key)) continue;
    }
    const value = typeof raw === "boolean" ? String(raw) : String(raw ?? "");
    validateSetting(key,value);
    updates.set(key,value);
  }
  for (const key of clearKeys.map(String)) {
    validateSetting(key,"");
    updates.set(key,"");
  }

  if (updates.has("PLATFORM_HOST")) {
    updates.set("COOKIE_SECURE", updates.get("PLATFORM_HOST") ? "true" : "false");
  }

  const { lines } = await parseEnvFile();
  const remaining = new Map(updates);
  const nextLines = lines.map((line) => {
    const idx = line.indexOf("=");
    if (idx <= 0 || /^\s*#/.test(line)) return line;
    const key = line.slice(0,idx).trim();
    if (!remaining.has(key)) return line;
    const value = remaining.get(key);
    remaining.delete(key);
    return `${key}=${value}`;
  });
  for (const [key,value] of remaining.entries()) nextLines.push(`${key}=${value}`);

  const temp = envFile + ".tmp";
  await fs.writeFile(temp,nextLines.join("\n"),{mode:0o600});

  // Keep one last-known-good environment snapshot until the restarted management
  // stack proves healthy. The apply script restores this automatically on failure.
  await fs.copyFile(envFile,settingsPreviousEnvFile);
  await fs.chmod(settingsPreviousEnvFile,0o600);
  await fs.rename(temp,envFile);

  const jobId = "set_" + crypto.randomBytes(10).toString("hex");
  await fs.writeFile(settingsStateFile, JSON.stringify({
    status:"queued", jobId, startedAt:new Date().toISOString(), finishedAt:null, error:null
  },null,2),{mode:0o600});

  const script = path.join(root,"scripts","platform-apply-settings.sh");
  const child = spawn("bash",[script,jobId],{
    cwd:root,
    detached:true,
    env:{...process.env,HOST_PROJECT_DIR:root},
    stdio:"ignore"
  });
  child.unref();

  return { jobId, restartScheduled:true, changedKeys:[...updates.keys()].filter((key)=>!secretKeys.has(key)), secretKeysChanged:[...updates.keys()].filter((key)=>secretKeys.has(key)) };
}

async function git(args) {
  const { stdout } = await exec("git", ["-C", root, ...args], { timeout: 30_000, maxBuffer: 2_000_000 });
  return stdout.trim();
}

async function updateInfo() {
  const currentSha = await git(["rev-parse", "HEAD"]).catch(() => null);
  let targetSha = null;
  let remoteError = null;
  try {
    if (/^[0-9a-f]{40}$/i.test(updateRef)) {
      targetSha = updateRef.toLowerCase();
    } else {
      const { stdout } = await exec("git", ["-C", root, "ls-remote", "origin", `refs/heads/${updateRef}`], {
        timeout: 20_000,
        maxBuffer: 1_000_000
      });
      targetSha = stdout.trim().split(/\s+/)[0] || null;
    }
  } catch (error) {
    remoteError = error instanceof Error ? error.message : String(error);
  }
  return {
    ref: updateRef,
    currentSha,
    targetSha,
    updateAvailable: Boolean(currentSha && targetSha && currentSha !== targetSha),
    remoteError
  };
}

async function startUpdate() {
  const state = await readState();
  if (state.status === "running") {
    const error = new Error("platform update already running");
    error.code = "BUSY";
    throw error;
  }

  const jobId = "upd_" + crypto.randomBytes(10).toString("hex");
  const info = await updateInfo();
  const next = {
    status: info.updateAvailable ? "running" : "up_to_date",
    ref: updateRef,
    jobId,
    startedAt: new Date().toISOString(),
    finishedAt: info.updateAvailable ? null : new Date().toISOString(),
    currentSha: info.currentSha,
    targetSha: info.targetSha,
    error: info.remoteError
  };
  await writeState(next);

  if (!info.updateAvailable) return next;

  await fs.writeFile(logFile, `[${new Date().toISOString()}] Starting platform update ${info.currentSha} -> ${info.targetSha}\n`, { mode: 0o600 });

  const script = path.join(root, "scripts", "platform-self-update.sh");
  const child = spawn("bash", [script, updateRef, jobId], {
    cwd: root,
    env: { ...process.env, HOST_PROJECT_DIR: root, PLATFORM_UPDATE_REF: updateRef },
    stdio: ["ignore", "pipe", "pipe"]
  });

  const handleChunk = async (chunk) => {
    await fs.appendFile(logFile, chunk);
  };
  child.stdout.on("data", (chunk) => { void handleChunk(chunk); });
  child.stderr.on("data", (chunk) => { void handleChunk(chunk); });

  child.on("close", async (code) => {
    const finalInfo = await updateInfo();
    const finalState = await readState();
    await writeState({
      ...finalState,
      status: code === 0 ? "completed" : "failed",
      finishedAt: new Date().toISOString(),
      currentSha: finalInfo.currentSha,
      targetSha: finalInfo.targetSha,
      error: code === 0 ? null : `platform updater exited with code ${code}`
    });
  });

  child.on("error", async (error) => {
    const current = await readState();
    await writeState({
      ...current,
      status: "failed",
      finishedAt: new Date().toISOString(),
      error: error.message
    });
  });

  return next;
}

function send(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(data.length),
    "cache-control": "no-store"
  });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://updater.local");
    if (req.method === "GET" && url.pathname === "/healthz") {
      return send(res, 200, { status: "ok", component: "platform-updater" });
    }

    if (!authorized(req)) return send(res, 401, { error: "invalid updater token" });

    if (req.method === "GET" && url.pathname === "/settings") {
      return send(res, 200, {
        settings: await platformSettingsView(),
        apply: { ...(await readSettingsState()), log: await tailSettingsLog() }
      });
    }

    if (req.method === "POST" && url.pathname === "/settings") {
      let body="";
      for await (const chunk of req) {
        body += chunk.toString();
        if (body.length > 1024*1024) return send(res,413,{error:"settings payload too large"});
      }
      const parsed = body ? JSON.parse(body) : {};
      try {
        return send(res,202,await writePlatformSettings(parsed));
      } catch (error) {
        return send(res,400,{error:error instanceof Error ? error.message : String(error)});
      }
    }

    if (req.method === "GET" && url.pathname === "/info") {
      return send(res, 200, await updateInfo());
    }

    if (req.method === "GET" && url.pathname === "/status") {
      return send(res, 200, { ...(await readState()), log: await tailLog() });
    }

    if (req.method === "POST" && url.pathname === "/update") {
      try {
        return send(res, 202, await startUpdate());
      } catch (error) {
        if (error?.code === "BUSY") return send(res, 409, { error: error.message });
        throw error;
      }
    }

    return send(res, 404, { error: "not found" });
  } catch (error) {
    console.error(error);
    return send(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`My Railway platform updater listening on :${port}; channel=${updateRef}`);
});
