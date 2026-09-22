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
const backupVolumeName = env("BACKUP_VOLUME_NAME", "myrailway-backups");

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

function maintenanceContainerName(serviceId: string): string {
  return `mr-maint-${serviceId.toLowerCase().replace(/[^a-z0-9_.-]+/g,"-").slice(-80)}`;
}

async function waitMaintenanceReady(containerName: string): Promise<void> {
  let last="";
  for(let i=0;i<20;i++){
    try{
      const code=await docker([
        "run","--rm","--network",network,
        "curlimages/curl:8.10.1",
        "--silent","--output","/dev/null","--write-out","%{http_code}",
        "--max-time","3",
        `http://${containerName}:3000/`
      ],15_000);
      if(code.trim()==="503") return;
      last=`HTTP ${code}`;
    }catch(error){
      last=error instanceof Error ? error.message : String(error);
    }
    await sleep(500);
  }
  throw new Error(`Maintenance responder failed readiness: ${last.slice(-500)}`);
}

export async function setServiceMaintenance(
  serviceId: string,
  enabled: boolean,
  message: string,
  domains: string[]
) {
  const name=maintenanceContainerName(serviceId);

  if(!enabled){
    await docker(["rm","-f",name]).catch(()=>{});
    return refreshServiceRoute(serviceId,domains);
  }

  await docker(["rm","-f",name]).catch(()=>{});
  const escapedMessage = String(message)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#39;");
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Maintenance</title><style>body{margin:0;background:#0a0b0d;color:#f5f7fb;font:16px system-ui;display:grid;place-items:center;min-height:100vh}.card{max-width:640px;padding:40px;border:1px solid #2b2f37;border-radius:16px;background:#111318;text-align:center}h1{margin-top:0;font-size:32px}p{color:#b5bdc9;line-height:1.6}</style></head><body><main class="card"><h1>Maintenance</h1><p>${escapedMessage}</p></main></body></html>`;
  const htmlB64 = Buffer.from(html,"utf8").toString("base64");
  const responderScript = "const http=require('http');const html=Buffer.from(process.env.MAINTENANCE_HTML_B64||'', 'base64');http.createServer((req,res)=>{res.writeHead(503,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','retry-after':'300'});res.end(html)}).listen(3000,'0.0.0.0');";

  await docker([
    "run","-d",
    "--name",name,
    "--network",network,
    "--restart","unless-stopped",
    "--cpus","0.25",
    "--memory","128m",
    "--pids-limit","64",
    "--label",`myrailway.maintenance.service=${serviceId}`,
    "-e",`MAINTENANCE_HTML_B64=${htmlB64}`,
    "my-railway:local",
    "node","-e",responderScript
  ]);

  await waitMaintenanceReady(name);
  await activateRoute(serviceId,name,3000,domains);
  return { enabled:true,containerName:name,domains };
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
  maintenanceEnabled?: boolean;
  maintenanceMessage?: string|null;
  volumes?: Array<{name:string;mountPath:string;readOnly?:boolean}>;
};

export type CronRunPayload = {
  runId: string;
  serviceId: string;
  image: string;
  command: string;
  cpuLimit: number;
  memoryMb: number;
  timeoutSeconds: number;
  environment: Record<string,string>;
  volumes?: Array<{name:string;mountPath:string;readOnly?:boolean}>;
};

export async function runCronJob(payload: CronRunPayload) {
  if (!payload.image.startsWith("myrailway/")) {
    await docker(["pull",payload.image],10*60_000);
  }

  const envData=await envFile(payload.environment ?? {});
  const containerName=`mr-cron-${payload.runId.replace(/[^a-zA-Z0-9_.-]/g,"-").slice(-40)}`;
  const args=[
    "run","--rm",
    "--name",containerName,
    "--network",network,
    "--cpus",String(payload.cpuLimit || 1),
    "--memory",`${payload.memoryMb || 512}m`,
    "--pids-limit","512",
    "--env-file",envData.file,
    "--label",`myrailway.service=${payload.serviceId}`,
    "--label",`myrailway.cronRun=${payload.runId}`
  ];
  for(const volume of payload.volumes ?? []){
    args.push("-v",`${volume.name}:${volume.mountPath}${volume.readOnly ? ":ro" : ""}`);
  }
  args.push(payload.image,"sh","-lc",payload.command);

  const { spawn } = await import("node:child_process");
  let stdout="";
  let stderr="";
  let timedOut=false;
  try{
    const result=await new Promise<{exitCode:number}>((resolve,reject)=>{
      const child=spawn("docker",args,{stdio:["ignore","pipe","pipe"]});
      const timer=setTimeout(()=>{
        timedOut=true;
        void docker(["rm","-f",containerName]).catch(()=>{});
        child.kill("SIGKILL");
      },Math.max(1,payload.timeoutSeconds || 900)*1000);
      timer.unref();

      child.stdout.on("data",(chunk)=>{stdout=(stdout+chunk.toString()).slice(-500_000);});
      child.stderr.on("data",(chunk)=>{stderr=(stderr+chunk.toString()).slice(-500_000);});
      child.on("error",(error)=>{clearTimeout(timer);reject(error);});
      child.on("close",(code)=>{
        clearTimeout(timer);
        if(timedOut) return resolve({exitCode:124});
        resolve({exitCode:code ?? 1});
      });
    });
    return {
      exitCode:result.exitCode,
      timedOut,
      logs:(stdout+stderr).slice(-1_000_000)
    };
  } finally {
    await docker(["rm","-f",containerName]).catch(()=>{});
    await envData.cleanup();
  }
}

export async function deploy(payload: DeployPayload) {
  if (!payload.image.startsWith("myrailway/")) {
    await docker(["pull", payload.image], 10 * 60_000);
  }
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
      "--label",`myrailway.deployment=${payload.deploymentId}`,
      "--label",`myrailway.kind=${payload.kind}`,
      "--label",`myrailway.port=${payload.port}`,
      "--label",`myrailway.healthPath=${payload.healthPath || "/"}`
    ];
    for (const volume of payload.volumes ?? []) {
      args.push("-v", `${volume.name}:${volume.mountPath}${volume.readOnly ? ":ro" : ""}`);
    }
    args.push(payload.image);
    await docker(args);

    if (payload.kind === "web") {
      await waitHealthy(payload.containerName, payload.port, payload.healthPath);
      if (payload.maintenanceEnabled) {
        await setServiceMaintenance(
          payload.serviceId,
          true,
          payload.maintenanceMessage ?? "We are performing scheduled maintenance. Please try again shortly.",
          payload.domains ?? []
        );
      } else {
        await docker(["rm","-f",maintenanceContainerName(payload.serviceId)]).catch(()=>{});
        await activateRoute(payload.serviceId, payload.containerName, payload.port, payload.domains ?? []);
      }
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

export async function refreshServiceRoute(serviceId: string, domains: string[]) {
  const names = await serviceContainers(serviceId);
  if (!names.length) {
    await removeRoute(serviceId);
    return { routed:false, reason:"no running container" };
  }
  const name = names[0]!;
  const raw = await docker(["inspect",name]);
  const info = JSON.parse(raw)?.[0];
  const labels = info?.Config?.Labels ?? {};
  const port = Number(labels["myrailway.port"] ?? 80);
  const running = Boolean(info?.State?.Running);
  if (!running) {
    await removeRoute(serviceId);
    return { routed:false, reason:"container not running" };
  }
  await activateRoute(serviceId,name,port,domains);
  return { routed:domains.length>0,containerName:name,port,domains };
}

export async function stopService(serviceId: string) {
  await removeRoute(serviceId);
  const names = await serviceContainers(serviceId);
  for (const name of names) await docker(["rm","-f",name]).catch(()=>{});
  await docker(["rm","-f",maintenanceContainerName(serviceId)]).catch(()=>{});
  return { stopped: names };
}

export async function restartService(serviceId: string) {
  const names = await serviceContainers(serviceId);
  for (const name of names) await docker(["restart",name]);
  return { restarted: names };
}

export async function removeVolume(volumeName: string, serviceId?: string, deleteData=false) {
  if (serviceId) await stopService(serviceId);
  if (deleteData) {
    await docker(["volume","rm","-f",volumeName], 120_000);
    return { detached:true, deletedData:true, volumeName };
  }
  return { detached:true, deletedData:false, volumeName };
}

export async function backupVolume(volumeName: string, backupName: string) {
  await fs.mkdir(backupDir, { recursive:true });
  const safe = backupName.replace(/[^a-zA-Z0-9_.-]/g, "-");
  const file = `${safe}.tar.gz`;
  await docker([
    "run","--rm",
    "-v",`${volumeName}:/source:ro`,
    "-v",`${backupVolumeName}:/backup`,
    "alpine:3.20",
    "tar","czf",`/backup/${file}`,"-C","/source","."
  ], 30 * 60_000);
  const backupPath = path.join(backupDir,file);
  await fs.chmod(backupPath,0o600).catch(()=>{});
  const stat = await fs.stat(backupPath);
  return { location: backupPath, sizeBytes: stat.size };
}

export async function testVolumeBackup(fileName: string) {
  const safe = path.basename(fileName);
  const scratch = `mr-restore-test-${Date.now()}`;
  await docker(["volume","create",scratch]);
  try {
    await docker([
      "run","--rm",
      "-v",`${scratch}:/target`,
      "-v",`${backupVolumeName}:/backup:ro`,
      "alpine:3.20","sh","-lc",
      `tar tzf /backup/${safe} >/dev/null && tar xzf /backup/${safe} -C /target`
    ], 30 * 60_000);
    return { tested: safe, scratchVolume: scratch };
  } finally {
    await docker(["volume","rm","-f",scratch]).catch(()=>{});
  }
}

export async function restoreVolume(volumeName: string, fileName: string, serviceId?: string) {
  if (serviceId) await stopService(serviceId);
  const safe = path.basename(fileName);
  await docker([
    "run","--rm",
    "-v",`${volumeName}:/target`,
    "-v",`${backupVolumeName}:/backup:ro`,
    "alpine:3.20","sh","-lc",
    `rm -rf /target/* /target/.[!.]* /target/..?* 2>/dev/null || true; tar xzf /backup/${safe} -C /target`
  ], 30 * 60_000);
  return { restored: safe };
}

export type DatabasePayload = {
  databaseId: string;
  kind: "postgres"|"redis";
  dockerName: string;
  volumeName: string;
  username?: string|null;
  password: string;
  databaseName?: string|null;
};

export async function provisionDatabase(payload: DatabasePayload) {
  const image = payload.kind === "postgres" ? "postgres:17-alpine" : "redis:7-alpine";
  await docker(["pull", image], 10 * 60_000);
  await docker(["volume","create",payload.volumeName]);
  await docker(["rm","-f",payload.dockerName]).catch(()=>{});

  const environment: Record<string,string> = payload.kind === "postgres"
    ? {
        POSTGRES_USER: payload.username ?? "myrailway",
        POSTGRES_PASSWORD: payload.password,
        POSTGRES_DB: payload.databaseName ?? "app"
      }
    : { REDIS_PASSWORD: payload.password };

  const envData = await envFile(environment);
  try {
    const args = [
      "run","-d",
      "--name",payload.dockerName,
      "--network",network,
      "--restart","unless-stopped",
      "--cpus","1",
      "--memory","1024m",
      "--pids-limit","512",
      "--env-file",envData.file,
      "--label",`myrailway.database=${payload.databaseId}`,
      "--label",`myrailway.database.kind=${payload.kind}`,
      "-v",`${payload.volumeName}:${payload.kind === "postgres" ? "/var/lib/postgresql/data" : "/data"}`,
      image
    ];
    if (payload.kind === "redis") {
      args.push("sh","-lc",'exec redis-server --appendonly yes --requirepass "$REDIS_PASSWORD"');
    }
    await docker(args);

    let lastError = "";
    for (let i=0;i<40;i++) {
      try {
        if (payload.kind === "postgres") {
          await docker(["exec",payload.dockerName,"sh","-lc",'PGPASSWORD="$POSTGRES_PASSWORD" pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"']);
        } else {
          const pong = await docker(["exec",payload.dockerName,"sh","-lc",'redis-cli -a "$REDIS_PASSWORD" ping 2>/dev/null']);
          if (!pong.includes("PONG")) throw new Error("Redis did not return PONG");
        }
        return { dockerName:payload.dockerName, volumeName:payload.volumeName, ready:true };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        await sleep(1500);
      }
    }
    throw new Error(`Database readiness check failed: ${lastError.slice(-1000)}`);
  } catch (error) {
    await docker(["rm","-f",payload.dockerName]).catch(()=>{});
    throw error;
  } finally {
    await envData.cleanup();
  }
}

async function streamDockerToFile(args: string[], target: string, timeoutMs=30*60_000) {
  const { spawn } = await import("node:child_process");
  const { createWriteStream } = await import("node:fs");
  await new Promise<void>((resolve,reject)=>{
    const child=spawn("docker",args,{stdio:["ignore","pipe","pipe"]});
    const out=createWriteStream(target,{mode:0o600});
    let stderr="";
    const timer=setTimeout(()=>child.kill("SIGKILL"),timeoutMs);
    child.stdout.pipe(out);
    child.stderr.on("data",(chunk)=>{stderr=(stderr+chunk.toString()).slice(-8000);});
    child.on("error",(error)=>{clearTimeout(timer);out.destroy();reject(error);});
    child.on("close",(code)=>{
      clearTimeout(timer);
      out.end();
      code===0?resolve():reject(new Error(`docker command failed (${code}): ${stderr}`));
    });
  });
}

export async function backupDatabase(payload: DatabasePayload & {backupName:string}) {
  await fs.mkdir(backupDir,{recursive:true});
  const safe=payload.backupName.replace(/[^a-zA-Z0-9_.-]/g,"-");
  if(payload.kind==="postgres"){
    const file=`${safe}.dump`;
    const target=path.join(backupDir,file);
    await streamDockerToFile([
      "exec",payload.dockerName,"sh","-lc",
      'PGPASSWORD="$POSTGRES_PASSWORD" exec pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
    ],target);
    const stat=await fs.stat(target);
    return {location:target,sizeBytes:stat.size};
  }

  await docker(["exec",payload.dockerName,"sh","-lc",'redis-cli -a "$REDIS_PASSWORD" SAVE >/dev/null 2>&1']);
  const file=`${safe}.rdb`;
  const target=path.join(backupDir,file);
  await docker(["cp",`${payload.dockerName}:/data/dump.rdb`,target],5*60_000);
  await fs.chmod(target,0o600).catch(()=>{});
  const stat=await fs.stat(target);
  return {location:target,sizeBytes:stat.size};
}

export async function testDatabaseBackup(payload: {kind:"postgres"|"redis";dockerName:string;fileName:string}) {
  const safe=path.basename(payload.fileName);
  if(payload.kind==="postgres"){
    await docker(["cp",path.join(backupDir,safe),`${payload.dockerName}:/tmp/myrailway-test.dump`],5*60_000);
    try {
      await docker(["exec",payload.dockerName,"pg_restore","--list","/tmp/myrailway-test.dump"],5*60_000);
    } finally {
      await docker(["exec",payload.dockerName,"rm","-f","/tmp/myrailway-test.dump"]).catch(()=>{});
    }
    return {tested:safe,format:"postgres-custom"};
  }
  await docker([
    "run","--rm","-v",`${backupVolumeName}:/backup:ro`,"redis:7-alpine",
    "redis-check-rdb",`/backup/${safe}`
  ],5*60_000);
  return {tested:safe,format:"redis-rdb"};
}

export async function restoreDatabase(payload: DatabasePayload & {fileName:string;serviceId?:string|null}) {
  if(payload.serviceId) await stopService(payload.serviceId);
  const safe=path.basename(payload.fileName);
  if(payload.kind==="postgres"){
    await docker(["cp",path.join(backupDir,safe),`${payload.dockerName}:/tmp/myrailway-restore.dump`],5*60_000);
    try {
      await docker([
        "exec",payload.dockerName,"sh","-lc",
        'PGPASSWORD="$POSTGRES_PASSWORD" pg_restore --clean --if-exists --no-owner -U "$POSTGRES_USER" -d "$POSTGRES_DB" /tmp/myrailway-restore.dump'
      ],30*60_000);
    } finally {
      await docker(["exec",payload.dockerName,"rm","-f","/tmp/myrailway-restore.dump"]).catch(()=>{});
    }
    return {restored:safe};
  }

  await docker(["stop",payload.dockerName],2*60_000);
  try {
    await docker([
      "run","--rm",
      "-v",`${payload.volumeName}:/data`,
      "-v",`${backupVolumeName}:/backup:ro`,
      "alpine:3.20","sh","-lc",
      [
        "rm -rf /data/appendonlydir",
        "rm -f /data/appendonly.aof /data/appendonly.aof.*",
        `cp /backup/${safe} /data/dump.rdb`,
        "chmod 644 /data/dump.rdb"
      ].join(" && ")
    ],5*60_000);
    await docker(["start",payload.dockerName],2*60_000);

    let ready=false;
    let lastError="";
    for(let i=0;i<40;i++){
      try{
        const pong=await docker([
          "exec",payload.dockerName,"sh","-lc",
          'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli ping 2>/dev/null'
        ],30_000);
        if(pong.includes("PONG")){
          ready=true;
          break;
        }
      }catch(error){
        lastError=error instanceof Error ? error.message : String(error);
      }
      await sleep(500);
    }
    if(!ready) throw new Error(`Redis did not become healthy after restore: ${lastError}`);
  } catch (error) {
    await docker(["start",payload.dockerName],2*60_000).catch(()=>{});
    throw error;
  }
  return {restored:safe};
}

export type DatabaseHealth = {
  databaseId: string;
  dockerName: string;
  kind: "postgres"|"redis";
  running: boolean;
  healthy: boolean;
  message: string | null;
};

export async function runtimeDatabaseHealth(): Promise<DatabaseHealth[]> {
  const out = await docker(["ps","-a","--filter","label=myrailway.database","--format","{{.Names}}"]);
  const names = out ? out.split("\n").filter(Boolean) : [];
  const results: DatabaseHealth[] = [];
  for (const name of names) {
    try {
      const raw = await docker(["inspect",name]);
      const info = JSON.parse(raw)?.[0];
      const labels = info?.Config?.Labels ?? {};
      const databaseId = labels["myrailway.database"];
      if (!databaseId) continue;
      const image = String(info?.Config?.Image ?? "");
      const kind = (labels["myrailway.database.kind"] || (image.includes("postgres") ? "postgres" : "redis")) as "postgres"|"redis";
      const running = Boolean(info?.State?.Running);
      if (!running) {
        results.push({databaseId,dockerName:name,kind,running:false,healthy:false,message:info?.State?.Status ?? "not running"});
        continue;
      }
      try {
        if (kind === "postgres") {
          await docker(["exec",name,"sh","-lc",'PGPASSWORD="$POSTGRES_PASSWORD" pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"'],30_000);
        } else {
          const pong = await docker(["exec",name,"sh","-lc",'redis-cli -a "$REDIS_PASSWORD" ping 2>/dev/null'],30_000);
          if (!pong.includes("PONG")) throw new Error("Redis did not return PONG");
        }
        results.push({databaseId,dockerName:name,kind,running:true,healthy:true,message:null});
      } catch (error) {
        results.push({databaseId,dockerName:name,kind,running:true,healthy:false,message:error instanceof Error ? error.message : String(error)});
      }
    } catch (error) {
      console.error(`Database health inspection failed for ${name}:`, error);
    }
  }
  return results;
}

export async function removeDatabase(dockerName: string, volumeName?: string, deleteData=false, serviceId?: string) {
  if (serviceId) await stopService(serviceId);
  await docker(["rm","-f",dockerName]).catch(()=>{});
  if (deleteData && volumeName) await docker(["volume","rm","-f",volumeName]).catch(()=>{});
  return {dockerName,removed:true,dataDeleted:Boolean(deleteData && volumeName),serviceStopped:Boolean(serviceId)};
}

export type RuntimeHealth = {
  serviceId: string;
  deploymentId: string | null;
  containerName: string;
  running: boolean;
  healthy: boolean;
  statusCode: number | null;
  latencyMs: number | null;
  message: string | null;
};

export async function runtimeServiceHealth(): Promise<RuntimeHealth[]> {
  const out = await docker(["ps","-a","--filter","label=myrailway.service","--format","{{.Names}}"]);
  const names = out ? out.split("\n").filter(Boolean) : [];
  const results: RuntimeHealth[] = [];
  for (const name of names) {
    try {
      const raw = await docker(["inspect",name]);
      const info = JSON.parse(raw)?.[0];
      const labels = info?.Config?.Labels ?? {};
      const running = Boolean(info?.State?.Running);
      const kind = labels["myrailway.kind"] ?? "web";
      const serviceId = labels["myrailway.service"];
      const deploymentId = labels["myrailway.deployment"] ?? null;
      if (!serviceId) continue;
      if (!running) {
        results.push({serviceId,deploymentId,containerName:name,running:false,healthy:false,statusCode:null,latencyMs:null,message:info?.State?.Status ?? "not running"});
        continue;
      }
      if (kind !== "web") {
        results.push({serviceId,deploymentId,containerName:name,running:true,healthy:true,statusCode:null,latencyMs:null,message:"worker running"});
        continue;
      }
      const port = Number(labels["myrailway.port"] ?? 80);
      const healthPath = labels["myrailway.healthPath"] ?? "/";
      const ip = info?.NetworkSettings?.Networks?.[network]?.IPAddress;
      const target = ip || name;
      const started = Date.now();
      try {
        const response = await fetch(`http://${target}:${port}${healthPath}`, { signal: AbortSignal.timeout(5000) });
        results.push({
          serviceId,deploymentId,containerName:name,running:true,healthy:response.ok,
          statusCode:response.status,latencyMs:Date.now()-started,
          message:response.ok ? null : `HTTP ${response.status}`
        });
      } catch (error) {
        results.push({
          serviceId,deploymentId,containerName:name,running:true,healthy:false,statusCode:null,
          latencyMs:Date.now()-started,message:error instanceof Error ? error.message : String(error)
        });
      }
    } catch (error) {
      results.push({
        serviceId:"unknown",deploymentId:null,containerName:name,running:false,healthy:false,statusCode:null,latencyMs:null,
        message:error instanceof Error ? error.message : String(error)
      });
    }
  }
  return results.filter((item)=>item.serviceId !== "unknown");
}

export async function runtimeLogs(serviceId: string) {
  const names = await serviceContainers(serviceId);
  if (!names.length) return { containerName:null, logs:"No managed container is currently present." };
  const name = names[0]!;
  const { stdout, stderr } = await exec("docker", ["logs","--tail","300","--timestamps",name], {
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024
  });
  return { containerName:name, logs:(stdout + stderr).slice(-1_000_000) };
}

export async function platformSelfTest() {
  const checks: Array<{name:string;ok:boolean;detail:string}> = [];
  const check = async (name:string, fn:()=>Promise<string|void>) => {
    try {
      const detail = await fn();
      checks.push({name,ok:true,detail:String(detail ?? "ok")});
    } catch (error) {
      checks.push({name,ok:false,detail:error instanceof Error ? error.message : String(error)});
    }
  };

  await check("docker", async()=>docker(["version","--format","{{.Server.Version}}"]));
  await check("private-network", async()=>{ await docker(["network","inspect",network]); return network; });
  await check("route-storage", async()=>{
    await fs.mkdir(env("TRAEFIK_ROUTES_DIR", "/var/lib/myrailway/routes"), {recursive:true});
    const target=path.join(env("TRAEFIK_ROUTES_DIR", "/var/lib/myrailway/routes"), ".self-test");
    await fs.writeFile(target,"ok",{mode:0o600});
    await fs.rm(target,{force:true});
    return "writable";
  });
  await check("backup-storage", async()=>{
    await fs.mkdir(backupDir,{recursive:true});
    const target=path.join(backupDir,".self-test");
    await fs.writeFile(target,"ok",{mode:0o600});
    await fs.rm(target,{force:true});
    return "writable";
  });
  await check("ephemeral-container", async()=>{
    await docker(["pull","alpine:3.20"], 5 * 60_000);
    return docker(["run","--rm","--network",network,"alpine:3.20","sh","-lc","printf my-railway-ok"]);
  });
  const scratch=`mr-self-test-${Date.now()}`;
  await check("volume-lifecycle", async()=>{
    await docker(["volume","create",scratch]);
    try {
      await docker(["run","--rm","-v",`${scratch}:/data`,"alpine:3.20","sh","-lc","echo ok >/data/test && test -s /data/test"]);
      return "create/write/read";
    } finally {
      await docker(["volume","rm","-f",scratch]).catch(()=>{});
    }
  });

  return { ok:checks.every((item)=>item.ok), checkedAt:new Date().toISOString(), checks };
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
