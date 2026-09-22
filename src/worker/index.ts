import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Worker } from "bullmq";
import { pool, one, query } from "../shared/db.js";
import { redis } from "../shared/queue.js";
import { decryptSecret } from "../shared/crypto.js";
import { env, optionalEnv } from "../shared/env.js";
import { id, safeContainerName, sleep } from "../shared/util.js";
import { prepareDockerfile, run } from "./build.js";

type Deployment = {
  id: string; service_id: string; commit_sha: string|null; image_ref: string|null; status: string;
  project_name: string; project_slug: string;
  service_name: string; repo_full_name: string; branch: string; root_directory: string;
  build_type: "auto"|"docker"|"node"|"python"|"static"; dockerfile_path: string;
  build_command: string|null; start_command: string|null; predeploy_command: string|null;
  internal_port: number; health_path: string; cpu_limit: string|number; memory_mb: number; kind: "web"|"worker";
  runtime_port: number|null; detected_build_type: string|null;
};

const registry = env("REGISTRY_URL", "local");
const githubToken = optionalEnv("GITHUB_TOKEN");

async function log(deploymentId: string, message: string, level="info") {
  const clean = message.replace(githubToken ?? "__NO_TOKEN__", githubToken ? "***" : "__NO_TOKEN__").slice(0, 8000);
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
      s.build_command,s.start_command,s.predeploy_command,s.internal_port,s.health_path,s.cpu_limit,s.memory_mb,s.kind
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
      WHERE id=$1 AND last_seen_at > now() - interval '45 seconds' AND memory_free_mb >= $2
      LIMIT 1
    `, [localServerId, memoryMb]);
  }
  return one<any>(`
    SELECT * FROM servers
    WHERE last_seen_at > now() - interval '45 seconds'
      AND memory_free_mb >= $1
    ORDER BY load1 ASC NULLS LAST, memory_free_mb DESC
    LIMIT 1
  `, [memoryMb]);
}

async function waitForCommand(commandId: string, deploymentId: string): Promise<any> {
  const deadline = Date.now() + 12 * 60_000;
  while (Date.now() < deadline) {
    const command = await one<any>("SELECT status,result FROM agent_commands WHERE id=$1", [commandId]);
    if (command?.status === "completed") return command.result ?? {};
    if (command?.status === "failed") throw new Error(command.result?.error ?? "runtime agent command failed");
    await sleep(1500);
  }
  throw new Error("runtime agent timed out");
}

async function cloneRepository(dep: Deployment, repoDir: string) {
  const authPrefix = githubToken ? `x-access-token:${encodeURIComponent(githubToken)}@` : "";
  const cloneUrl = `https://${authPrefix}github.com/${dep.repo_full_name}.git`;
  await status(dep.id, "CLONING");
  await log(dep.id, `Cloning ${dep.repo_full_name} @ ${dep.branch}`);
  await run("git", ["clone","--no-tags","--depth","50","--branch",dep.branch,cloneUrl,repoDir], os.tmpdir(), (line)=>log(dep.id,line));
  if (dep.commit_sha) {
    await run("git", ["fetch","--depth","1","origin",dep.commit_sha], repoDir, (line)=>log(dep.id,line));
    await run("git", ["checkout","--detach",dep.commit_sha], repoDir, (line)=>log(dep.id,line));
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
    const localMode = registry === "local";
    const image = localMode
      ? `myrailway/${dep.project_slug}-${dep.service_id.slice(-6)}:${shortSha}`
      : `${registry}/${dep.project_slug}-${dep.service_id.slice(-6)}:${shortSha}`;

    await status(dep.id, "BUILDING");
    await run("docker", [
      "build",
      "--file", prepared.dockerfile,
      "--tag", image,
      "."
    ], workdir, (line)=>log(dep.id,line), { DOCKER_BUILDKIT: "1" });

    if (!localMode) {
      await status(dep.id, "PUSHING_IMAGE");
      await log(dep.id, `Pushing image to ${registry}`);
      await run("docker", ["push", image], workdir, (line)=>log(dep.id,line));
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

async function processDeployment(deploymentId: string) {
  let dep = await deploymentInfo(deploymentId);
  if (!dep) throw new Error("deployment not found");

  const lockKey = `deploy-lock:${dep.service_id}`;
  const locked = await redis.set(lockKey, deploymentId, "EX", 1800, "NX");
  if (locked !== "OK") {
    await log(deploymentId, "Another deployment for this service is already active; waiting.");
    throw new Error("service deployment lock busy");
  }

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

    const vars = await query<any>("SELECT key,value_enc FROM variables WHERE service_id=$1", [dep.service_id]);
    const environment: Record<string,string> = {};
    for (const v of vars) environment[v.key] = decryptSecret(v.value_enc);
    if (!environment.PORT) environment.PORT = String(runtimePort);

    const domains = await query<{hostname:string}>("SELECT hostname FROM domains WHERE service_id=$1 AND verified=true ORDER BY hostname", [dep.service_id]);
    const volumes = await query<{docker_volume_name:string;mount_path:string;read_only:boolean}>(
      "SELECT docker_volume_name,mount_path,read_only FROM volumes WHERE service_id=$1 ORDER BY created_at",
      [dep.service_id]
    );
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
      predeployCommand: dep.predeploy_command,
      environment,
      domains: domains.map((d)=>d.hostname),
      volumes: volumes.map((v)=>({ name:v.docker_volume_name, mountPath:v.mount_path, readOnly:v.read_only }))
    };

    await status(dep.id, "PROVISIONING");
    await pool.query(
      "INSERT INTO agent_commands(id,server_id,deployment_id,action,payload) VALUES($1,$2,$3,'DEPLOY',$4)",
      [commandId, server.id, dep.id, JSON.stringify(payload)]
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
    if (await redis.get(lockKey) === deploymentId) await redis.del(lockKey);
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
