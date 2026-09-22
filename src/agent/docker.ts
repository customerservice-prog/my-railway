import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { env, intEnv } from "../shared/env.js";
import { sleep } from "../shared/util.js";
import { activateRoute, removeRoute } from "./routes.js";

const exec = promisify(execFile);
const network = env("PLATFORM_NETWORK", "myrailway");
const backupDir = env("BACKUP_DIR", "/var/lib/myrailway/backups");

async function docker(args: string[], timeout=120_000): Promise<string> {
  const { stdout } = await exec("docker", args, { timeout, maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

async function envFile(environment: Record<string,string>): Promise<{file:string;cleanup:()=>Promise<void>}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "myrailway-env-"));
  const file = path.join(dir, "env");
  const body = Object.entries(environment)
    .map(([k,v]) => `${k}=${String(v).replace(/\r?\n/g, "\\n")}`)
    .join("\n") + "\n";
  await fs.writeFile(file, body, { mode: 0o600 });
  return { file, cleanup: () => fs.rm(dir, { recursive:true, force:true }) };
}

async function serviceContainers(serviceId: string): Promise<string[]> {
  const out = await docker(["ps","-a","--filter",`label=myrailway.service=${serviceId}`,"--format","{{.Names}}"]);
  return out ? out.split("\n").filter(Boolean) : [];
}

async function waitHealthy(containerName: string, port: number, healthPath: string): Promise<void> {
  const retries = intEnv("DEPLOY_HEALTH_RETRIES", 24);
  const interval = intEnv("DEPLOY_HEALTH_INTERVAL_MS", 2500);
  let last = "";
  for (let i=0;i<retries;i++) {
    try {
      await docker([
        "run","--rm","--network",network,
        "curlimages/curl:8.10.1",
        "--fail","--silent","--show-error","--max-time","5",
        `http://${containerName}:${port}${healthPath || "/"}`
      ], 30_000);
      return;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
      await sleep(interval);
    }
  }
  throw new Error(`Health check failed for ${containerName}: ${last.slice(-1000)}`);
}

export type DeployPayload = {
  serviceId: string;
  deploymentId: string;
  image: string;
  containerName: string;
  kind: "web"|"worker";
  port: number;
  healthPath: string;
  cpuLimit: number;
  memoryMb: number;
  predeployCommand?: string|null;
  environment: Record<string,string>;
  domains: string[];
  volumes?: Array<{name:string;mountPath:string;readOnly?:boolean}>;
};

export async function deploy(payload: DeployPayload) {
  await docker(["pull", payload.image], 10 * 60_000);
  const envData = await envFile(payload.environment ?? {});
  try {
    if (payload.predeployCommand) {
      const migrateArgs = [
        "run","--rm","--network",network,
        "--env-file",envData.file
      ];
      for (const volume of payload.volumes ?? []) {
        migrateArgs.push("-v", `${volume.name}:${volume.mountPath}${volume.readOnly ? ":ro" : ""}`);
      }
      migrateArgs.push(payload.image, "sh", "-lc", payload.predeployCommand);
      await docker(migrateArgs, 10 * 60_000);
    }

    await docker(["rm","-f",payload.containerName]).catch(()=>{});
    const args = [
      "run","-d",
      "--name",payload.containerName,
      "--network",network,
      "--restart","unless-stopped",
      "--cpus",String(payload.cpuLimit || 1),
      "--memory",`${payload.memoryMb || 1024}m`,
      "--pids-limit","512",
      "--env-file",envData.file,
      "--label",`myrailway.service=${payload.serviceId}`,
      "--label",`myrailway.deployment=${payload.deploymentId}`
    ];
    for (const volume of payload.volumes ?? []) {
      args.push("-v", `${volume.name}:${volume.mountPath}${volume.readOnly ? ":ro" : ""}`);
    }
    args.push(payload.image);
    await docker(args);

    if (payload.kind === "web") {
      await waitHealthy(payload.containerName, payload.port, payload.healthPath);
      await activateRoute(payload.serviceId, payload.containerName, payload.port, payload.domains ?? []);
    }

    const grace = intEnv("DEPLOY_GRACE_SECONDS", 10);
    await sleep(grace * 1000);
    const old = (await serviceContainers(payload.serviceId)).filter((name) => name !== payload.containerName);
    for (const name of old) await docker(["rm","-f",name]).catch(()=>{});

    return { containerName: payload.containerName, replaced: old };
  } catch (error) {
    await docker(["rm","-f",payload.containerName]).catch(()=>{});
    throw error;
  } finally {
    await envData.cleanup();
  }
}

export async function stopService(serviceId: string) {
  await removeRoute(serviceId);
  const names = await serviceContainers(serviceId);
  for (const name of names) await docker(["rm","-f",name]).catch(()=>{});
  return { stopped: names };
}

export async function restartService(serviceId: string) {
  const names = await serviceContainers(serviceId);
  for (const name of names) await docker(["restart",name]);
  return { restarted: names };
}

export async function backupVolume(volumeName: string, backupName: string) {
  await fs.mkdir(backupDir, { recursive:true });
  const safe = backupName.replace(/[^a-zA-Z0-9_.-]/g, "-");
  const file = `${safe}.tar.gz`;
  await docker([
    "run","--rm",
    "-v",`${volumeName}:/source:ro`,
    "-v",`${backupDir}:/backup`,
    "alpine:3.20",
    "tar","czf",`/backup/${file}`,"-C","/source","."
  ], 30 * 60_000);
  const stat = await fs.stat(path.join(backupDir,file));
  return { location: path.join(backupDir,file), sizeBytes: stat.size };
}

export async function restoreVolume(volumeName: string, fileName: string) {
  const safe = path.basename(fileName);
  await docker([
    "run","--rm",
    "-v",`${volumeName}:/target`,
    "-v",`${backupDir}:/backup:ro`,
    "alpine:3.20","sh","-lc",
    `rm -rf /target/* /target/.[!.]* /target/..?* 2>/dev/null || true; tar xzf /backup/${safe} -C /target`
  ], 30 * 60_000);
  return { restored: safe };
}

export async function runtimeStats() {
  const cpuCount = os.cpus().length;
  const memoryTotalMb = Math.round(os.totalmem()/1024/1024);
  const memoryFreeMb = Math.round(os.freemem()/1024/1024);
  let diskTotalMb = 0;
  let diskFreeMb = 0;
  try {
    const { stdout } = await exec("df", ["-Pk","/"]);
    const line = stdout.trim().split("\n").at(-1)?.trim().split(/\s+/);
    if (line && line.length >= 4) {
      diskTotalMb = Math.round(Number(line[1])/1024);
      diskFreeMb = Math.round(Number(line[3])/1024);
    }
  } catch {}
  let containerCount = 0;
  try {
    const out = await docker(["ps","-q"]);
    containerCount = out ? out.split("\n").filter(Boolean).length : 0;
  } catch {}
  return {
    cpuCount, memoryTotalMb, memoryFreeMb, diskTotalMb, diskFreeMb,
    load1: os.loadavg()[0] ?? 0, containerCount
  };
}
