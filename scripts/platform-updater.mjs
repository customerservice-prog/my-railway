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
