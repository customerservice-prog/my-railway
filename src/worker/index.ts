import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Worker } from "bullmq";
import { pool, one, query } from "../shared/db.js";
import { redis } from "../shared/queue.js";
import { decryptSecret, encryptSecret } from "../shared/crypto.js";
import { env, boolEnv, intEnv } from "../shared/env.js";
import { getGitHubCloneToken, gitHubAuthEnvironment } from "../shared/github.js";
import { id, safeContainerName, sleep } from "../shared/util.js";
import { prepareDockerfile, run } from "./build.js";

type Deployment = {
  id: string; service_id: string; commit_sha: string|null; image_ref: string|null; status: string; source: string;
  project_name: string; project_slug: string;
  service_name: string; repo_full_name: string; branch: string; root_directory: string;
  build_type: "auto"|"docker"|"node"|"python"|"static"; dockerfile_path: string;
  build_command: string|null; start_command: string|null; predeploy_command: string|null;
  internal_port: number; health_path: string; cpu_limit: string|number; memory_mb: number; kind: "web"|"worker"|"cron";
  runtime_port: number|null; detected_build_type: string|null;
  maintenance_enabled: boolean; maintenance_message: string;
};

const registry = env("REGISTRY_URL", "local");
const gitTimeoutMs = intEnv("GIT_TIMEOUT_SECONDS", 300) * 1000;
const buildTimeoutMs = intEnv("BUILD_TIMEOUT_SECONDS", 1800) * 1000;
const agentCommandTimeoutMs = intEnv("AGENT_COMMAND_TIMEOUT_SECONDS", 1800) * 1000;
const autoPredeployBackups = boolEnv("AUTO_PREDEPLOY_BACKUPS", true);
async function log(deploymentId: string, message: string, level="info") {
  const clean = message.slice(0, 8000);
  await pool.query("INSERT INTO deployment_logs(deployment_id,level,message) VALUES($1,$2,$3)", [deploymentId, level, clean]);
  console.log(`[${deploymentId}] ${clean}`);
}

async function status(deploymentId: string, next: string, failure?: string) {
  await pool.query(
    `UPDATE deployments SET status=$2,
      started_at=CASE WHEN started_at IS NULL AND $2 <> 'QUEUED' THEN now() ELSE started_at END,
      completed_at=CASE WHEN $2 IN ('RUNNING','BUILD_FAILED','DEPLOY_FAILED','SUPERSEDED','CANCELLED') THEN now() ELSE completed_at END,
      failure_reason=$3
     WHERE id=$1`,
    [deploymentId, next, failure ?? null]
  );
}

async function deploymentInfo(deploymentId: string): Promise<Deployment | null> {
  return one<Deployment>(`
    SELECT d.*, p.name project_name, p.slug project_slug,
      s.name service_name,s.repo_full_name,s.branch,s.root_directory,s.build_type,s.dockerfile_path,
      s.build_command,s.start_command,s.predeploy_command,s.internal_port,s.health_path,s.cpu_limit,s.memory_mb,s.kind,
      s.maintenance_enabled,s.maintenance_message
    FROM deployments d
    JOIN services s ON s.id=d.service_id
    JOIN projects p ON p.id=s.project_id
    WHERE d.id=$1
  `, [deploymentId]);
}

async function chooseServer(memoryMb: number) {
  const localServerId = registry === "local" ? env("SERVER_ID", "local-runtime-01") : null;
  if (localServerId) {
    return one<any>(`
      SELECT * FROM servers
      WHERE id=$1 AND draining=false AND last_seen_at > now() - interval '45 seconds' AND memory_free_mb >= $2
      LIMIT 1
    `, [localServerId, memoryMb]);
  }
  return one<any>(`
    SELECT * FROM servers
    WHERE draining=false AND last_seen_at > now() - interval '45 seconds'
      AND memory_free_mb >= $1
    ORDER BY load1 ASC NULLS LAST, memory_free_mb DESC
    LIMIT 1
  `, [memoryMb]);
}

async function waitForCommand(commandId: string, deploymentId: string): Promise<any> {
  const deadline = Date.now() + agentCommandTimeoutMs;
  while (Date.now() < deadline) {
    const command = await one<any>("SELECT status,result FROM agent_commands WHERE id=$1", [commandId]);
    if (command?.status === "completed") return command.result ?? {};
    if (command?.status === "failed") throw new Error(command.result?.error ?? "runtime agent command failed");
    await sleep(1500);
  }
  throw new Error("runtime agent timed out");
}

async function cloneRepository(dep: Deployment, repoDir: string) {
  const token = await getGitHubCloneToken();
  const cloneUrl = `https://github.com/${dep.repo_full_name}.git`;
  const gitEnv = gitHubAuthEnvironment(token);
  await status(dep.id, "CLONING");
  await log(dep.id, `Cloning ${dep.repo_full_name} @ ${dep.branch}`);
  await run("git", ["clone","--no-tags","--depth","50","--branch",dep.branch,cloneUrl,repoDir], os.tmpdir(), (line)=>log(dep.id,line), gitEnv, gitTimeoutMs);
  if (dep.commit_sha) {
    await run("git", ["fetch","--depth","1","origin",dep.commit_sha], repoDir, (line)=>log(dep.id,line), gitEnv, gitTimeoutMs);
    await run("git", ["checkout","--detach",dep.commit_sha], repoDir, (line)=>log(dep.id,line), gitEnv, gitTimeoutMs);
  } else {
    const { execFile } = await import("node:child_process");
    dep.commit_sha = await new Promise<string>((resolve,reject) => execFile("git",["rev-parse","HEAD"],{cwd:repoDir},(err,stdout)=>err?reject(err):resolve(stdout.trim())));
    await pool.query("UPDATE deployments SET commit_sha=$2 WHERE id=$1", [dep.id, dep.commit_sha]);
  }
}

async function buildImage(dep: Deployment): Promise<{image:string;runtimePort:number;detected:string}> {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "myrailway-build-"));
  try {
    await cloneRepository(dep, repoDir);
    const workdir = path.resolve(repoDir, dep.root_directory || ".");
    if (!workdir.startsWith(repoDir + path.sep) && workdir !== repoDir) throw new Error("root_directory escapes repository");
    const prepared = await prepareDockerfile(workdir, dep);
    const runtimePort = prepared.detected === "static" ? 80 : dep.internal_port;
    await log(dep.id, `Build type: ${prepared.detected}; runtime port: ${runtimePort}`);

    const shortSha = (dep.commit_sha ?? dep.id).slice(0, 12).replace(/[^a-zA-Z0-9_.-]/g,"");
    const releaseId = dep.id.replace(/^dep_/,"").slice(-10).replace(/[^a-zA-Z0-9_.-]/g,"");
    const releaseTag = `${shortSha}-${releaseId}`;
    const localMode = registry === "local";
    // A commit SHA is not enough to identify a built release: build settings, root directory,
    // Dockerfile, environment-independent build args, etc. can change while source SHA stays the same.
    // Every deployment therefore receives a unique tag so rollback can never be silently retargeted.
    const image = localMode
      ? `myrailway/${dep.project_slug}-${dep.service_id.slice(-6)}:${releaseTag}`
      : `${registry}/${dep.project_slug}-${dep.service_id.slice(-6)}:${releaseTag}`;

    await status(dep.id, "BUILDING");
    await run("docker", [
      "build",
      "--file", prepared.dockerfile,
      "--tag", image,
      "--label", "myrailway.managed=true",
      "--label", `myrailway.service=${dep.service_id}`,
      "--label", `myrailway.deployment=${dep.id}`,
      "."
    ], workdir, (line)=>log(dep.id,line), { DOCKER_BUILDKIT: "1" }, buildTimeoutMs);

    if (!localMode) {
      await status(dep.id, "PUSHING_IMAGE");
      await log(dep.id, `Pushing image to ${registry}`);
      await run("docker", ["push", image], workdir, (line)=>log(dep.id,line), undefined, buildTimeoutMs);
    }

    await pool.query(
      "UPDATE deployments SET image_ref=$2,runtime_port=$3,detected_build_type=$4 WHERE id=$1",
      [dep.id, image, runtimePort, prepared.detected]
    );
    await log(dep.id, localMode ? `Built local immutable image ${image}` : `Published immutable image ${image}`);
    return { image, runtimePort, detected: prepared.detected };
  } finally {
    await fs.rm(repoDir, { recursive:true, force:true });
  }
}

async function enqueueRuntimeCommand(
  serverId: string,
  deploymentId: string,
  action: string,
  payload: unknown
) {
  const commandId = id("cmd");
  await pool.query(
    "INSERT INTO agent_commands(id,server_id,deployment_id,action,payload,payload_enc) VALUES($1,$2,$3,$4,'{}'::jsonb,$5)",
    [commandId,serverId,deploymentId,action,encryptSecret(JSON.stringify(payload))]
  );
  return commandId;
}

async function requireOnlineServer(serverId: string, purpose: string) {
  const server = await one<any>(
    "SELECT id,name,draining FROM servers WHERE id=$1 AND last_seen_at > now() - interval '45 seconds'",
    [serverId]
  );
  if (!server) throw new Error(`Runtime server ${serverId} is offline; cannot ${purpose}`);
  if (server.draining) throw new Error(`Runtime server ${server.name ?? serverId} is draining; cannot ${purpose}`);
  return server;
}

async function createPredeployRecoveryPoint(dep: Deployment, runtimeServerId: string) {
  if (!autoPredeployBackups) {
    await log(dep.id, "Automatic pre-deploy backups are disabled by AUTO_PREDEPLOY_BACKUPS.");
    return;
  }

  const databases = await query<any>(
    `SELECT * FROM database_resources
     WHERE service_id=$1 AND status='running'
     ORDER BY created_at`,
    [dep.service_id]
  );

  for (const database of databases) {
    await requireOnlineServer(database.server_id, `back up managed ${database.kind} database ${database.name}`);
    const backupId = id("bak");
    await pool.query(
      "INSERT INTO backups(id,service_id,database_id,server_id,kind,status) VALUES($1,$2,$3,$4,$5,'queued')",
      [backupId,dep.service_id,database.id,database.server_id,`database-${database.kind}`]
    );
    const commandId = await enqueueRuntimeCommand(database.server_id,dep.id,"BACKUP_DATABASE",{
      databaseId:database.id,
      kind:database.kind,
      dockerName:database.docker_name,
      volumeName:database.volume_name,
      username:database.username,
      password:decryptSecret(database.password_enc),
      databaseName:database.database_name,
      serviceId:dep.service_id,
      backupId,
      backupName:backupId
    });
    await log(dep.id, `Creating pre-deploy recovery backup ${backupId} for managed database ${database.name}.`);
    await waitForCommand(commandId,dep.id);
    await log(dep.id, `Pre-deploy database backup ${backupId} completed.`);
  }

  const volumes = await query<any>(
    `SELECT * FROM volumes
     WHERE service_id=$1 AND status='attached' AND read_only=false
     ORDER BY created_at`,
    [dep.service_id]
  );

  if (volumes.length) await requireOnlineServer(runtimeServerId,"back up attached persistent volumes");

  for (const volume of volumes) {
    const backupId = id("bak");
    await pool.query(
      "INSERT INTO backups(id,service_id,volume_id,server_id,kind,status) VALUES($1,$2,$3,$4,'volume','queued')",
      [backupId,dep.service_id,volume.id,runtimeServerId]
    );
    const commandId = await enqueueRuntimeCommand(runtimeServerId,dep.id,"BACKUP_VOLUME",{
      volumeName:volume.docker_volume_name,
      backupName:backupId,
      backupId,
      serviceId:dep.service_id
    });
    await log(dep.id, `Creating pre-deploy recovery backup ${backupId} for volume ${volume.name}.`);
    await waitForCommand(commandId,dep.id);
    await log(dep.id, `Pre-deploy volume backup ${backupId} completed.`);
  }
}

async function acquireServiceLock(serviceId: string, deploymentId: string): Promise<(() => Promise<void>) | null> {
  const lockKey = `deploy-lock:${serviceId}`;
  const deadline = Date.now() + 30 * 60_000;
  const renewScript = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("expire", KEYS[1], ARGV[2])
    end
    return 0
  `;
  const releaseScript = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    end
    return 0
  `;

  while (Date.now() < deadline) {
    const newest = await one<{id:string}>(
      "SELECT id FROM deployments WHERE service_id=$1 ORDER BY created_at DESC LIMIT 1",
      [serviceId]
    );
    if (newest?.id && newest.id !== deploymentId) {
      await status(deploymentId, "SUPERSEDED");
      await log(deploymentId, `Superseded by newer deployment ${newest.id} before acquiring the service lock.`);
      return null;
    }

    const acquired = await redis.set(lockKey, deploymentId, "EX", 120, "NX");
    if (acquired === "OK") {
      const timer = setInterval(() => {
        void redis.eval(renewScript, 1, lockKey, deploymentId, "120").catch((error) => {
          console.error(`Failed to renew deployment lock ${lockKey}:`, error);
        });
      }, 30_000);
      timer.unref();

      return async () => {
        clearInterval(timer);
        await redis.eval(releaseScript, 1, lockKey, deploymentId).catch(() => 0);
      };
    }

    await sleep(1500);
  }

  throw new Error("Timed out waiting for service deployment lock");
}

async function processDeployment(deploymentId: string) {
  let dep = await deploymentInfo(deploymentId);
  if (!dep) throw new Error("deployment not found");

  const releaseLock = await acquireServiceLock(dep.service_id, deploymentId);
  if (!releaseLock) return;

  try {
    const newest = await one<{id:string}>("SELECT id FROM deployments WHERE service_id=$1 ORDER BY created_at DESC LIMIT 1", [dep.service_id]);
    if (newest?.id !== deploymentId && dep.status === "QUEUED") {
      await status(deploymentId, "SUPERSEDED");
      await log(deploymentId, "Superseded by a newer deployment.");
      return;
    }

    let image = dep.image_ref;
    let runtimePort = dep.runtime_port ?? (dep.build_type === "static" ? 80 : dep.internal_port);
    if (!image) {
      try {
        const built = await buildImage(dep);
        image = built.image;
        runtimePort = built.runtimePort;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await status(dep.id, "BUILD_FAILED", message);
        await log(dep.id, message, "error");
        throw error;
      }
    } else {
      await log(dep.id, `Rollback/redeploy using existing image ${image}`);
    }

    dep = (await deploymentInfo(deploymentId))!;
    const server = await chooseServer(dep.memory_mb);
    if (!server) throw new Error(`No healthy runtime server has at least ${dep.memory_mb} MB free`);
    await pool.query("UPDATE deployments SET server_id=$2 WHERE id=$1", [dep.id, server.id]);

    if (dep.kind === "cron") {
      await pool.query(
        "UPDATE deployments SET status='SUPERSEDED' WHERE service_id=$1 AND id<>$2 AND status='RUNNING'",
        [dep.service_id, dep.id]
      );
      await status(dep.id, "RUNNING");
      await log(dep.id, "Cron release published. Scheduled runs will execute this immutable image as one-off containers.");
      return;
    }

    const vars = await query<any>("SELECT key,value_enc FROM variables WHERE service_id=$1", [dep.service_id]);
    const environment: Record<string,string> = {};
    for (const v of vars) environment[v.key] = decryptSecret(v.value_enc);
    if (!environment.PORT) environment.PORT = String(runtimePort);

    const domains = await query<{hostname:string}>("SELECT hostname FROM domains WHERE service_id=$1 AND verified=true ORDER BY hostname", [dep.service_id]);
    const volumes = await query<{docker_volume_name:string;mount_path:string;read_only:boolean}>(
      "SELECT docker_volume_name,mount_path,read_only FROM volumes WHERE service_id=$1 AND status='attached' ORDER BY created_at",
      [dep.service_id]
    );
    const isRollback = dep.source === "rollback" || dep.source === "auto-rollback";
    const predeployCommand = isRollback ? null : dep.predeploy_command;

    if (predeployCommand) {
      await status(dep.id, "MIGRATING");
      await createPredeployRecoveryPoint(dep,server.id);
      await log(dep.id, "Pre-deploy recovery point is ready; migration may proceed.");
    }

    const commandId = id("cmd");
    const containerName = safeContainerName(`mr-${dep.service_id}-${dep.id.slice(-8)}`);
    const payload = {
      serviceId: dep.service_id,
      deploymentId: dep.id,
      image,
      containerName,
      kind: dep.kind,
      port: runtimePort,
      healthPath: dep.health_path,
      cpuLimit: Number(dep.cpu_limit),
      memoryMb: dep.memory_mb,
      predeployCommand,
      environment,
      domains: domains.map((d)=>d.hostname),
      maintenanceEnabled: Boolean(dep.maintenance_enabled),
      maintenanceMessage: dep.maintenance_message,
      volumes: volumes.map((v)=>({ name:v.docker_volume_name, mountPath:v.mount_path, readOnly:v.read_only }))
    };

    await status(dep.id, "PROVISIONING");
    await pool.query(
      "INSERT INTO agent_commands(id,server_id,deployment_id,action,payload,payload_enc) VALUES($1,$2,$3,'DEPLOY','{}'::jsonb,$4)",
      [commandId, server.id, dep.id, encryptSecret(JSON.stringify(payload))]
    );
    await log(dep.id, `Assigned to runtime ${server.name} (${server.id})`);
    await waitForCommand(commandId, dep.id);
    await pool.query(
      "UPDATE deployments SET status='SUPERSEDED' WHERE service_id=$1 AND id<>$2 AND status='RUNNING'",
      [dep.service_id, dep.id]
    );
    await status(dep.id, "RUNNING");
    await log(dep.id, "Deployment is healthy and receiving traffic.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const current = await one<{status:string}>("SELECT status FROM deployments WHERE id=$1", [deploymentId]);
    if (current && !["BUILD_FAILED","SUPERSEDED"].includes(current.status)) await status(deploymentId, "DEPLOY_FAILED", message);
    await log(deploymentId, message, "error");
    throw error;
  } finally {
    await releaseLock();
  }
}

const worker = new Worker("deployments", async (job) => {
  await processDeployment(String(job.data.deploymentId));
}, {
  connection: redis,
  concurrency: Number(process.env.DEPLOY_CONCURRENCY ?? 2),
  lockDuration: 15 * 60_000
});

worker.on("completed", (job) => console.log(`Deployment job ${job.id} complete`));
worker.on("failed", (job, error) => console.error(`Deployment job ${job?.id} failed:`, error.message));

console.log("My Railway deployment worker online");
