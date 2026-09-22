import express, { type NextFunction, type Request, type Response } from "express";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import path from "node:path";
import { authenticator } from "otplib";
import { z } from "zod";
import { CronExpressionParser } from "cron-parser";
import { pool, one, query, ensureSchema } from "../shared/db.js";
import { encryptSecret, decryptSecret } from "../shared/crypto.js";
import { env, optionalEnv, boolEnv } from "../shared/env.js";
import { deploymentQueue, enqueueDeployment } from "../shared/queue.js";
import { id, slug } from "../shared/util.js";

const app = express();
const port = Number(process.env.PORT ?? 8080);
const sessionSecret = env("SESSION_SECRET");
const agentToken = env("AGENT_TOKEN");
const updaterUrl = optionalEnv("PLATFORM_UPDATER_URL") ?? "http://updater:8090";
const updaterToken = optionalEnv("PLATFORM_UPDATER_TOKEN");
const cookieSecure = boolEnv("COOKIE_SECURE", false);

app.set("trust proxy", 1);
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if (cookieSecure) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  if (_req.path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
  next();
});

const loginAttempts = new Map<string,{count:number;resetAt:number}>();

type AuthedRequest = Request & { userId?: string };

function safeUser(user: Record<string, unknown>) {
  const { password_hash: _p, totp_secret_enc: _t, recovery_codes: recoveryCodes, ...rest } = user;
  return {
    ...rest,
    recovery_code_count: Array.isArray(recoveryCodes) ? recoveryCodes.length : 0
  };
}

function recoveryCodeHash(code: string) {
  return crypto.createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}

function generateRecoveryCodes() {
  const codes = Array.from({ length: 10 }, () =>
    crypto.randomBytes(10).toString("hex").match(/.{1,5}/g)!.join("-").toUpperCase()
  );
  return { codes, hashes: codes.map(recoveryCodeHash) };
}

async function consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
  const hash = recoveryCodeHash(code);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      "SELECT recovery_codes FROM users WHERE id=$1 FOR UPDATE",
      [userId]
    );
    const stored = Array.isArray(result.rows[0]?.recovery_codes) ? result.rows[0].recovery_codes as string[] : [];
    if (!stored.includes(hash)) {
      await client.query("ROLLBACK");
      return false;
    }
    const remaining = stored.filter((item) => item !== hash);
    await client.query("UPDATE users SET recovery_codes=$2 WHERE id=$1", [userId, JSON.stringify(remaining)]);
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function sameOriginMutation(req: Request): boolean {
  if (["GET","HEAD","OPTIONS"].includes(req.method.toUpperCase())) return true;

  const fetchSite = req.header("sec-fetch-site");
  if (fetchSite && !["same-origin","none"].includes(fetchSite)) return false;

  const origin = req.header("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === req.get("host");
  } catch {
    return false;
  }
}

function signSession(userId: string, sessionVersion: number) {
  return jwt.sign(
    { sub: userId, sv: sessionVersion },
    sessionSecret,
    { expiresIn: "12h", issuer: "my-railway" }
  );
}

async function auth(req: AuthedRequest, res: Response, next: NextFunction) {
  const token = req.cookies?.mr_session;
  if (!token) return res.status(401).json({ error: "authentication required" });
  try {
    const payload = jwt.verify(token, sessionSecret, { issuer: "my-railway" }) as jwt.JwtPayload;
    const userId = String(payload.sub ?? "");
    const user = await one<{session_version:number}>(
      "SELECT session_version FROM users WHERE id=$1",
      [userId]
    );
    if (!user || Number(payload.sv ?? 0) !== Number(user.session_version)) {
      return res.status(401).json({ error: "session expired or revoked" });
    }
    req.userId = userId;
    if (!sameOriginMutation(req)) {
      return res.status(403).json({ error: "cross-site state-changing request rejected" });
    }
    return next();
  } catch {
    return res.status(401).json({ error: "invalid session" });
  }
}

function agentAuth(req: Request, res: Response, next: NextFunction) {
  const supplied = req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const a = Buffer.from(supplied);
  const b = Buffer.from(agentToken);
  if (!supplied || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "invalid agent token" });
  }
  next();
}

async function platformUpdaterRequest(pathname: string, init: RequestInit = {}) {
  if (!updaterToken) throw new Error("platform updater token is not configured");
  const response = await fetch(updaterUrl.replace(/\/$/, "") + pathname, {
    ...init,
    headers: {
      "content-type":"application/json",
      "authorization":`Bearer ${updaterToken}`,
      ...(init.headers ?? {})
    },
    signal:AbortSignal.timeout(30_000)
  });
  const data = await response.json().catch(()=>({}));
  if (!response.ok) {
    const error = new Error(String((data as any)?.error ?? `updater request failed: ${response.status}`));
    (error as any).status = response.status;
    throw error;
  }
  return data as any;
}

async function audit(actor: string, action: string, targetType?: string, targetId?: string, detail: unknown = {}) {
  await pool.query(
    "INSERT INTO audit_events(actor,action,target_type,target_id,detail) VALUES($1,$2,$3,$4,$5)",
    [actor, action, targetType ?? null, targetId ?? null, JSON.stringify(detail)]
  );
}

async function publishAlert(alert: Record<string, unknown>) {
  const url = optionalEnv("ALERT_WEBHOOK_URL");
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "my-railway", ...alert }),
      signal: AbortSignal.timeout(5000)
    });
  } catch (error) {
    console.error("Alert webhook failed:", error);
  }
}

async function openAlert(input: {
  severity: "info"|"warning"|"critical";
  type: string;
  fingerprint: string;
  title: string;
  message: string;
  targetType?: string;
  targetId?: string;
}) {
  const alertId = id("alt");
  const result = await pool.query(
    `INSERT INTO alerts(id,severity,type,fingerprint,title,message,target_type,target_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (fingerprint) WHERE resolved_at IS NULL DO NOTHING
     RETURNING *`,
    [alertId,input.severity,input.type,input.fingerprint,input.title,input.message,input.targetType ?? null,input.targetId ?? null]
  );
  if (result.rowCount) await publishAlert(result.rows[0]);
  return result.rows[0] ?? null;
}

async function resolveAlert(fingerprint: string) {
  await pool.query("UPDATE alerts SET resolved_at=now() WHERE fingerprint=$1 AND resolved_at IS NULL", [fingerprint]);
}

async function enqueueAgentCommand(serverId: string, action: string, payload: unknown, deploymentId?: string) {
  const commandId = id("cmd");
  await pool.query(
    "INSERT INTO agent_commands(id,server_id,deployment_id,action,payload,payload_enc) VALUES($1,$2,$3,$4,'{}'::jsonb,$5)",
    [commandId,serverId,deploymentId ?? null,action,encryptSecret(JSON.stringify(payload))]
  );
  return commandId;
}

function managedDatabaseConnection(database: any, password: string) {
  return database.kind === "postgres"
    ? `postgresql://${encodeURIComponent(database.username)}:${encodeURIComponent(password)}@${database.docker_name}:5432/${encodeURIComponent(database.database_name)}`
    : `redis://:${encodeURIComponent(password)}@${database.docker_name}:6379/0`;
}

async function removeManagedConnectionVariable(database: any) {
  if (!database?.service_id || !database?.variable_key || !database?.password_enc) return;
  const variable = await one<{value_enc:string}>(
    "SELECT value_enc FROM variables WHERE service_id=$1 AND key=$2",
    [database.service_id,database.variable_key]
  );
  if (!variable) return;
  const expected = managedDatabaseConnection(database,decryptSecret(database.password_enc));
  const current = decryptSecret(variable.value_enc);
  if (current === expected) {
    await pool.query(
      "DELETE FROM variables WHERE service_id=$1 AND key=$2",
      [database.service_id,database.variable_key]
    );
  }
}

function nextCronAt(expression: string, timezone: string, from: Date, hashSeed?: string): Date {
  const interval = CronExpressionParser.parse(expression, {
    currentDate: from,
    tz: timezone || "UTC",
    hashSeed
  });
  return interval.next().toDate();
}

function validateCron(expression: string, timezone: string, hashSeed?: string): string | null {
  try {
    nextCronAt(expression, timezone, new Date(), hashSeed);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function redactServiceSecrets(serviceId: string | undefined, value: string) {
  if (!serviceId) return value;
  const [vars, databases] = await Promise.all([
    query<{value_enc:string}>("SELECT value_enc FROM variables WHERE service_id=$1", [serviceId]),
    query<{password_enc:string}>("SELECT password_enc FROM database_resources WHERE service_id=$1", [serviceId])
  ]);
  let redacted=value;
  const secrets = [
    ...vars.map((row)=>decryptSecret(row.value_enc)),
    ...databases.map((row)=>decryptSecret(row.password_enc))
  ].filter((v)=>v.length>=4).sort((a,b)=>b.length-a.length);
  for(const secret of secrets) redacted=redacted.split(secret).join("***");
  return redacted;
}

async function redactResultValue(serviceId: string | undefined, value: unknown): Promise<unknown> {
  if (typeof value === "string") return redactServiceSecrets(serviceId, value);
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    for (const item of value) output.push(await redactResultValue(serviceId, item));
    return output;
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = await redactResultValue(serviceId, item);
    }
    return output;
  }
  return value;
}

async function runMetadataRetention() {
  const logDays = Math.max(1, Number(process.env.LOG_RETENTION_DAYS ?? 30) || 30);
  const commandDays = Math.max(1, Number(process.env.COMMAND_RETENTION_DAYS ?? 7) || 7);
  const webhookDays = Math.max(1, Number(process.env.WEBHOOK_RETENTION_DAYS ?? 30) || 30);
  const cronDays = Math.max(1, Number(process.env.CRON_RUN_RETENTION_DAYS ?? 90) || 90);
  const auditDays = Math.max(1, Number(process.env.AUDIT_RETENTION_DAYS ?? 365) || 365);
  const backupDays = Math.max(1, Number(process.env.BACKUP_RETENTION_DAYS ?? 30) || 30);

  await Promise.all([
    pool.query(
      "DELETE FROM deployment_logs WHERE ts < now() - ($1::int * interval '1 day')",
      [logDays]
    ),
    pool.query(
      "DELETE FROM agent_commands WHERE status IN ('completed','failed') AND completed_at < now() - ($1::int * interval '1 day')",
      [commandDays]
    ),
    pool.query(
      "DELETE FROM webhook_deliveries WHERE received_at < now() - ($1::int * interval '1 day')",
      [webhookDays]
    ),
    pool.query(
      "DELETE FROM cron_runs WHERE created_at < now() - ($1::int * interval '1 day')",
      [cronDays]
    ),
    pool.query(
      "DELETE FROM audit_events WHERE created_at < now() - ($1::int * interval '1 day')",
      [auditDays]
    ),
    pool.query(
      "DELETE FROM alerts WHERE resolved_at IS NOT NULL AND resolved_at < now() - ($1::int * interval '1 day')",
      [auditDays]
    ),
    pool.query(
      "DELETE FROM backups WHERE status IN ('completed','failed') AND created_at < now() - ($1::int * interval '1 day')",
      [backupDays]
    )
  ]);
}

async function runAutomaticBackups() {
  if (!boolEnv("AUTO_BACKUPS", true)) return;

  const retentionDays = Math.max(1, Number(process.env.BACKUP_RETENTION_DAYS ?? 30) || 30);
  await pool.query(
    "UPDATE backups SET status='expired' WHERE status='completed' AND created_at < now() - ($1::int * interval '1 day')",
    [retentionDays]
  );

  const databases=await query<any>(`
    SELECT d.* FROM database_resources d
    WHERE d.status='running' AND NOT EXISTS (
      SELECT 1 FROM backups b
      WHERE b.database_id=d.id AND b.created_at > now()-interval '20 hours' AND b.status IN ('queued','completed')
    )
  `);
  for(const database of databases){
    try{
      const backupId=id("bak");
      await pool.query(
        "INSERT INTO backups(id,service_id,database_id,server_id,kind,status) VALUES($1,$2,$3,$4,$5,'queued')",
        [backupId,database.service_id,database.id,database.server_id,`database-${database.kind}`]
      );
      await enqueueAgentCommand(database.server_id,"BACKUP_DATABASE",{
        databaseId:database.id,kind:database.kind,dockerName:database.docker_name,volumeName:database.volume_name,
        username:database.username,password:decryptSecret(database.password_enc),databaseName:database.database_name,
        backupId,backupName:backupId
      });
      await audit("system","backup.scheduled","database",database.id,{backupId});
    }catch(error){console.error("Scheduled database backup failed to queue:",error);}
  }

  const volumes=await query<any>(`
    SELECT v.* FROM volumes v
    WHERE v.status IN ('attached','detached','delete_failed')
      AND NOT EXISTS (
      SELECT 1 FROM backups b
      WHERE b.volume_id=v.id AND b.created_at > now()-interval '20 hours' AND b.status IN ('queued','completed')
    )
  `);
  for(const volume of volumes){
    try{
      const active=await one<any>(`
        SELECT server_id FROM deployments
        WHERE service_id=$1 AND server_id IS NOT NULL
        ORDER BY created_at DESC LIMIT 1
      `,[volume.service_id]);
      if(!active?.server_id) continue;
      const backupId=id("bak");
      await pool.query(
        "INSERT INTO backups(id,service_id,volume_id,server_id,kind,status) VALUES($1,$2,$3,$4,'volume','queued')",
        [backupId,volume.service_id,volume.id,active.server_id]
      );
      await enqueueAgentCommand(active.server_id,"BACKUP_VOLUME",{
        volumeName:volume.docker_volume_name,backupName:backupId,backupId
      });
      await audit("system","backup.scheduled","volume",volume.id,{backupId});
    }catch(error){console.error("Scheduled volume backup failed to queue:",error);}
  }
}

async function queueCronRun(service: any, scheduledFor: Date, source: "schedule"|"manual" = "schedule") {
  const deployment = await one<any>(`
    SELECT * FROM deployments
    WHERE service_id=$1 AND status='RUNNING' AND image_ref IS NOT NULL
    ORDER BY created_at DESC LIMIT 1
  `, [service.id]);

  const runId = id("crun");
  const inserted = await pool.query(
    `INSERT INTO cron_runs(id,service_id,deployment_id,server_id,scheduled_for,status)
     VALUES($1,$2,$3,$4,$5,'queued')
     ON CONFLICT(service_id,scheduled_for) DO NOTHING
     RETURNING *`,
    [runId,service.id,deployment?.id ?? null,deployment?.server_id ?? null,scheduledFor]
  );
  if (!inserted.rowCount) return null;

  if (!deployment?.image_ref || !deployment?.server_id) {
    await pool.query(
      "UPDATE cron_runs SET status='failed',completed_at=now(),logs=$2 WHERE id=$1",
      [runId,"No published cron deployment is available. Deploy the cron service before scheduling runs."]
    );
    await openAlert({
      severity:"warning",
      type:"cron",
      fingerprint:`cron:${service.id}`,
      title:`Cron job cannot run: ${service.name}`,
      message:"No published cron release is available.",
      targetType:"service",
      targetId:service.id
    });
    return {runId,commandId:null};
  }

  const server = await one<any>(
    "SELECT id,name,draining FROM servers WHERE id=$1 AND last_seen_at > now()-interval '45 seconds'",
    [deployment.server_id]
  );
  if (!server || server.draining) {
    await pool.query(
      "UPDATE cron_runs SET status='failed',completed_at=now(),logs=$2 WHERE id=$1",
      [runId,server?.draining ? "Runtime server is draining." : "Runtime server is offline."]
    );
    await openAlert({
      severity:"critical",
      type:"cron",
      fingerprint:`cron:${service.id}`,
      title:`Cron runtime unavailable: ${service.name}`,
      message:server?.draining ? "The assigned runtime is draining." : "The assigned runtime is offline.",
      targetType:"service",
      targetId:service.id
    });
    return {runId,commandId:null};
  }

  const vars = await query<any>("SELECT key,value_enc FROM variables WHERE service_id=$1", [service.id]);
  const environment: Record<string,string> = {};
  for (const variable of vars) environment[variable.key] = decryptSecret(variable.value_enc);

  const volumes = await query<any>(
    "SELECT docker_volume_name,mount_path,read_only FROM volumes WHERE service_id=$1 ORDER BY created_at",
    [service.id]
  );

  const commandId = await enqueueAgentCommand(server.id,"RUN_CRON",{
    runId,
    serviceId:service.id,
    image:deployment.image_ref,
    command:service.cron_command,
    cpuLimit:Number(service.cpu_limit),
    memoryMb:service.memory_mb,
    timeoutSeconds:service.cron_timeout_seconds ?? 900,
    environment,
    volumes:volumes.map((volume:any)=>({
      name:volume.docker_volume_name,
      mountPath:volume.mount_path,
      readOnly:volume.read_only
    })),
    source
  },deployment.id);

  await pool.query(
    "UPDATE cron_runs SET command_id=$2,started_at=now() WHERE id=$1",
    [runId,commandId]
  );
  await audit(source === "manual" ? "operator" : "system","cron.run.queued","cron_run",runId,{
    serviceId:service.id,scheduledFor,source
  });
  return {runId,commandId};
}

async function runCronSweep() {
  const services = await query<any>(`
    SELECT * FROM services
    WHERE kind='cron'
      AND cron_expression IS NOT NULL
      AND cron_command IS NOT NULL
      AND next_cron_at IS NOT NULL
      AND next_cron_at <= now()
    ORDER BY next_cron_at
    LIMIT 100
  `);

  for (const service of services) {
    try {
      const scheduledFor = new Date(service.next_cron_at);
      const nextRun = nextCronAt(
        service.cron_expression,
        service.cron_timezone || "UTC",
        new Date(scheduledFor.getTime() + 1000),
        service.id
      );

      const claimed = await pool.query(
        `UPDATE services SET next_cron_at=$2
         WHERE id=$1 AND next_cron_at=$3
         RETURNING id`,
        [service.id,nextRun,scheduledFor]
      );
      if (!claimed.rowCount) continue;

      await queueCronRun(service,scheduledFor,"schedule");
    } catch (error) {
      console.error(`Cron scheduling failed for ${service.id}:`,error);
      await openAlert({
        severity:"critical",
        type:"cron_scheduler",
        fingerprint:`cron-scheduler:${service.id}`,
        title:`Cron scheduler error: ${service.name}`,
        message:error instanceof Error ? error.message : String(error),
        targetType:"service",
        targetId:service.id
      });
    }
  }
}

async function createDeployment(
  serviceId: string,
  source: string,
  imageRef?: string,
  rollbackOf?: string,
  runtimePort?: number | null,
  detectedBuildType?: string | null,
  commitSha?: string | null
) {
  const deploymentId = id("dep");
  await pool.query(
    "INSERT INTO deployments(id,service_id,source,image_ref,rollback_of,runtime_port,detected_build_type,commit_sha,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'QUEUED')",
    [deploymentId, serviceId, source, imageRef ?? null, rollbackOf ?? null, runtimePort ?? null, detectedBuildType ?? null, commitSha ?? null]
  );
  await enqueueDeployment(deploymentId);
  return deploymentId;
}

/* GitHub must use the exact raw request body for HMAC verification. */
app.post("/api/webhooks/github", express.raw({ type: "application/json", limit: "2mb" }), async (req, res) => {
  try {
    const secret = optionalEnv("GITHUB_WEBHOOK_SECRET");
    if (!secret) return res.status(503).json({ error: "GitHub webhook secret is not configured" });

    const signature = req.header("x-hub-signature-256") ?? "";
    const raw = req.body as Buffer;
    const expected = "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
    const aa = Buffer.from(signature);
    const bb = Buffer.from(expected);
    if (aa.length !== bb.length || !crypto.timingSafeEqual(aa, bb)) {
      return res.status(401).json({ error: "invalid webhook signature" });
    }

    const deliveryId = req.header("x-github-delivery");
    const event = req.header("x-github-event") ?? "unknown";
    if (!deliveryId) return res.status(400).json({ error: "missing delivery id" });

    const inserted = await pool.query(
      "INSERT INTO webhook_deliveries(delivery_id,event) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING delivery_id",
      [deliveryId, event]
    );
    if (!inserted.rowCount) return res.status(202).json({ duplicate: true });

    if (event !== "push") {
      await pool.query("UPDATE webhook_deliveries SET processed_at=now(), status='ignored' WHERE delivery_id=$1", [deliveryId]);
      return res.status(202).json({ ignored: true });
    }

    const payload = JSON.parse(raw.toString("utf8"));
    const repoFullName = payload.repository?.full_name;
    const branch = String(payload.ref ?? "").replace("refs/heads/", "");
    const commitSha = payload.after;
    if (!repoFullName || !branch || !commitSha) return res.status(400).json({ error: "invalid push payload" });

    const services = await query<{id:string}>(
      "SELECT id FROM services WHERE repo_full_name=$1 AND branch=$2 AND auto_deploy=true",
      [repoFullName, branch]
    );

    const deployments: string[] = [];
    for (const service of services) {
      const deploymentId = id("dep");
      await pool.query(
        "INSERT INTO deployments(id,service_id,commit_sha,source,status) VALUES($1,$2,$3,'github','QUEUED')",
        [deploymentId, service.id, commitSha]
      );
      await enqueueDeployment(deploymentId);
      deployments.push(deploymentId);
    }

    await pool.query("UPDATE webhook_deliveries SET processed_at=now(), status='processed' WHERE delivery_id=$1", [deliveryId]);
    return res.status(202).json({ accepted: true, deployments });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "webhook processing failed" });
  }
});

app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());

app.get("/healthz", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", component: "control-plane" });
  } catch {
    res.status(503).json({ status: "error", component: "control-plane" });
  }
});

app.post("/api/auth/bootstrap", async (req, res) => {
  const count = await one<{count:string}>("SELECT count(*)::text AS count FROM users");
  if (Number(count?.count ?? "0") > 0) return res.status(409).json({ error: "platform already initialized" });

  const requiredToken = optionalEnv("ADMIN_BOOTSTRAP_TOKEN");
  if (!requiredToken) {
    return res.status(503).json({ error: "ADMIN_BOOTSTRAP_TOKEN is not configured" });
  }

  const parsed = z.object({
    email: z.string().email().default("admin@localhost"),
    password: z.string().min(12),
    setupToken: z.string().min(1)
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "email, password, and setup token are required" });

  const supplied = Buffer.from(parsed.data.setupToken);
  const expected = Buffer.from(requiredToken);
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    return res.status(401).json({ error: "invalid setup token" });
  }

  const userId = id("usr");
  const hash = await bcrypt.hash(parsed.data.password, 12);
  await pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)", [userId, parsed.data.email.toLowerCase(), hash]);
  await audit(parsed.data.email, "platform.bootstrap", "user", userId);
  res.status(201).json({ ok: true });
});

app.post("/api/auth/login", async (req, res) => {
  const loginKey = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const attempt = loginAttempts.get(loginKey);
  if (attempt && attempt.resetAt > now && attempt.count >= 10) {
    res.setHeader("Retry-After", String(Math.ceil((attempt.resetAt-now)/1000)));
    return res.status(429).json({ error: "too many login attempts; try again later" });
  }
  if (attempt && attempt.resetAt <= now) loginAttempts.delete(loginKey);

  const parsed = z.object({
    email: z.string().email(),
    password: z.string(),
    totp: z.string().optional(),
    recoveryCode: z.string().optional()
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid credentials" });
  const user = await one<any>("SELECT * FROM users WHERE email=$1", [parsed.data.email.toLowerCase()]);
  if (!user || !(await bcrypt.compare(parsed.data.password, user.password_hash))) {
    const current = loginAttempts.get(loginKey);
    loginAttempts.set(loginKey, {
      count:(current?.count ?? 0)+1,
      resetAt:current?.resetAt && current.resetAt > now ? current.resetAt : now + 15*60_000
    });
    return res.status(401).json({ error: "invalid credentials" });
  }
  let usedRecoveryCode = false;
  if (user.totp_enabled) {
    const secret = user.totp_secret_enc ? decryptSecret(user.totp_secret_enc) : null;
    const validTotp = Boolean(parsed.data.totp && secret && authenticator.check(parsed.data.totp, secret));
    if (!validTotp && parsed.data.recoveryCode) {
      usedRecoveryCode = await consumeRecoveryCode(user.id, parsed.data.recoveryCode);
    }
    if (!validTotp && !usedRecoveryCode) {
      return res.status(401).json({ error: "authenticator or recovery code required", totpRequired: true });
    }
  }
  loginAttempts.delete(loginKey);
  await pool.query("UPDATE users SET last_login_at=now() WHERE id=$1", [user.id]);
  res.cookie("mr_session", signSession(user.id, Number(user.session_version ?? 1)), {
    httpOnly: true,
    sameSite: "strict",
    secure: cookieSecure,
    maxAge: 12 * 60 * 60 * 1000,
    path: "/"
  });
  await audit(user.email, usedRecoveryCode ? "auth.login.recovery_code" : "auth.login", "user", user.id);
  res.json({ user: safeUser(user), usedRecoveryCode });
});

app.post("/api/auth/password", auth, async (req: AuthedRequest, res) => {
  const parsed = z.object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(12),
    totp: z.string().optional()
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "current password and a new password of at least 12 characters are required" });

  const user = await one<any>("SELECT * FROM users WHERE id=$1", [req.userId]);
  if (!user || !(await bcrypt.compare(parsed.data.currentPassword, user.password_hash))) {
    return res.status(401).json({ error: "invalid current password" });
  }
  if (user.totp_enabled) {
    if (!parsed.data.totp || !user.totp_secret_enc) return res.status(401).json({ error: "authenticator code required" });
    const secret = decryptSecret(user.totp_secret_enc);
    if (!authenticator.check(parsed.data.totp, secret)) return res.status(401).json({ error: "invalid authenticator code" });
  }

  const passwordHash = await bcrypt.hash(parsed.data.newPassword, 12);
  const updated = await one<any>(
    "UPDATE users SET password_hash=$2,session_version=session_version+1 WHERE id=$1 RETURNING session_version,email",
    [user.id,passwordHash]
  );
  res.cookie("mr_session", signSession(user.id, Number(updated.session_version)), {
    httpOnly:true,
    sameSite:"strict",
    secure:cookieSecure,
    maxAge:12*60*60*1000,
    path:"/"
  });
  await audit(updated.email,"auth.password.changed","user",user.id);
  res.json({ ok:true });
});

app.post("/api/auth/sessions/revoke", auth, async (req: AuthedRequest, res) => {
  const parsed = z.object({
    password: z.string().min(1),
    totp: z.string().optional()
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "password is required" });

  const user = await one<any>("SELECT * FROM users WHERE id=$1", [req.userId]);
  if (!user || !(await bcrypt.compare(parsed.data.password, user.password_hash))) {
    return res.status(401).json({ error: "invalid password" });
  }
  if (user.totp_enabled) {
    if (!parsed.data.totp || !user.totp_secret_enc) return res.status(401).json({ error: "authenticator code required" });
    const secret = decryptSecret(user.totp_secret_enc);
    if (!authenticator.check(parsed.data.totp, secret)) return res.status(401).json({ error: "invalid authenticator code" });
  }

  const updated = await one<any>(
    "UPDATE users SET session_version=session_version+1 WHERE id=$1 RETURNING session_version,email",
    [user.id]
  );
  res.cookie("mr_session", signSession(user.id, Number(updated.session_version)), {
    httpOnly:true,
    sameSite:"strict",
    secure:cookieSecure,
    maxAge:12*60*60*1000,
    path:"/"
  });
  await audit(updated.email,"auth.sessions.revoked","user",user.id);
  res.json({ ok:true });
});

app.post("/api/auth/logout", auth, async (req: AuthedRequest, res) => {
  res.clearCookie("mr_session", { path: "/" });
  await audit(req.userId ?? "unknown", "auth.logout");
  res.json({ ok: true });
});

app.get("/api/auth/me", auth, async (req: AuthedRequest, res) => {
  const user = await one<any>("SELECT * FROM users WHERE id=$1", [req.userId]);
  res.json({ user: user ? safeUser(user) : null });
});

app.post("/api/auth/totp/enroll", auth, async (req: AuthedRequest, res) => {
  const user = await one<any>("SELECT * FROM users WHERE id=$1", [req.userId]);
  if (!user) return res.status(404).json({ error: "user not found" });
  const secret = authenticator.generateSecret();
  await pool.query("UPDATE users SET totp_secret_enc=$1, totp_enabled=false WHERE id=$2", [encryptSecret(secret), user.id]);
  res.json({ secret, uri: authenticator.keyuri(user.email, "My Railway", secret) });
});

app.post("/api/auth/totp/confirm", auth, async (req: AuthedRequest, res) => {
  const token = String(req.body?.token ?? "");
  const user = await one<any>("SELECT * FROM users WHERE id=$1", [req.userId]);
  if (!user?.totp_secret_enc) return res.status(400).json({ error: "enroll first" });
  const secret = decryptSecret(user.totp_secret_enc);
  if (!authenticator.check(token, secret)) return res.status(400).json({ error: "invalid token" });
  const recovery = generateRecoveryCodes();
  await pool.query(
    "UPDATE users SET totp_enabled=true,recovery_codes=$2 WHERE id=$1",
    [user.id, JSON.stringify(recovery.hashes)]
  );
  await audit(user.email, "auth.totp.enabled", "user", user.id, { recoveryCodesGenerated: recovery.codes.length });
  res.json({ ok: true, recoveryCodes: recovery.codes });
});

app.post("/api/auth/recovery-codes/regenerate", auth, async (req: AuthedRequest, res) => {
  const parsed = z.object({
    password: z.string().min(1),
    totp: z.string().min(6).max(12)
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "password and authenticator code are required" });

  const user = await one<any>("SELECT * FROM users WHERE id=$1", [req.userId]);
  if (!user || !(await bcrypt.compare(parsed.data.password, user.password_hash))) {
    return res.status(401).json({ error: "invalid password" });
  }
  if (!user.totp_enabled || !user.totp_secret_enc) {
    return res.status(409).json({ error: "two-factor authentication is not enabled" });
  }
  const secret = decryptSecret(user.totp_secret_enc);
  if (!authenticator.check(parsed.data.totp, secret)) {
    return res.status(401).json({ error: "invalid authenticator code" });
  }

  const recovery = generateRecoveryCodes();
  await pool.query("UPDATE users SET recovery_codes=$2 WHERE id=$1", [user.id, JSON.stringify(recovery.hashes)]);
  await audit(user.email, "auth.recovery_codes.regenerated", "user", user.id, { recoveryCodesGenerated: recovery.codes.length });
  res.json({ recoveryCodes: recovery.codes });
});

app.get("/api/overview", auth, async (_req, res) => {
  const [projects, running, failed, servers, queued, backups] = await Promise.all([
    one<{count:string}>("SELECT count(*)::text count FROM projects"),
    one<{count:string}>("SELECT count(*)::text count FROM deployments WHERE status='RUNNING'"),
    one<{count:string}>("SELECT count(*)::text count FROM deployments WHERE status LIKE '%FAILED' OR status='UNHEALTHY'"),
    one<{count:string}>("SELECT count(*)::text count FROM servers WHERE last_seen_at > now() - interval '45 seconds'"),
    one<{count:string}>("SELECT count(*)::text count FROM deployments WHERE status IN ('QUEUED','CLONING','BUILDING','PUSHING_IMAGE','PROVISIONING','STARTING','HEALTH_CHECKING','MIGRATING','ACTIVATING')"),
    one<{count:string}>("SELECT count(*)::text count FROM backups WHERE status='completed'")
  ]);
  res.json({
    projects: Number(projects?.count ?? 0),
    running: Number(running?.count ?? 0),
    failed: Number(failed?.count ?? 0),
    onlineServers: Number(servers?.count ?? 0),
    queued: Number(queued?.count ?? 0),
    backups: Number(backups?.count ?? 0)
  });
});

app.get("/api/projects", auth, async (_req, res) => {
  const rows = await query<any>(`
    SELECT p.*,
      count(DISTINCT s.id)::int AS service_count,
      max(d.created_at) AS last_deploy_at,
      (array_agg(d.status ORDER BY d.created_at DESC) FILTER (WHERE d.status IS NOT NULL))[1] AS last_status
    FROM projects p
    LEFT JOIN services s ON s.project_id=p.id
    LEFT JOIN deployments d ON d.service_id=s.id
    GROUP BY p.id
    ORDER BY p.created_at DESC
  `);
  res.json(rows);
});

app.post("/api/projects", auth, async (req: AuthedRequest, res) => {
  const parsed = z.object({
    name: z.string().min(2).max(80),
    repoFullName: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    branch: z.string().min(1).default("main"),
    domain: z.string().min(3).optional(),
    kind: z.enum(["web", "worker", "cron"]).default("web"),
    buildType: z.enum(["auto", "docker", "node", "python", "static"]).default("auto"),
    internalPort: z.number().int().min(1).max(65535).default(3000),
    healthPath: z.string().startsWith("/").default("/"),
    cronExpression: z.string().min(1).optional(),
    cronTimezone: z.string().min(1).default("UTC"),
    cronCommand: z.string().min(1).optional(),
    cronTimeoutSeconds: z.number().int().min(1).max(86400).default(900)
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  if (parsed.data.kind === "cron") {
    if (!parsed.data.cronExpression || !parsed.data.cronCommand) {
      return res.status(400).json({ error: "cron services require cronExpression and cronCommand" });
    }
    const cronError = validateCron(parsed.data.cronExpression, parsed.data.cronTimezone);
    if (cronError) return res.status(400).json({ error: `invalid cron schedule: ${cronError}` });
  }

  const projectId = id("prj");
  const serviceId = id("svc");
  const projectSlug = `${slug(parsed.data.name)}-${crypto.randomBytes(2).toString("hex")}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO projects(id,name,slug) VALUES($1,$2,$3)", [projectId, parsed.data.name, projectSlug]);
    const nextCron = parsed.data.kind === "cron" && parsed.data.cronExpression
      ? nextCronAt(parsed.data.cronExpression, parsed.data.cronTimezone, new Date(), serviceId)
      : null;
    await client.query(
      `INSERT INTO services(
        id,project_id,name,kind,repo_full_name,branch,build_type,internal_port,health_path,
        cron_expression,cron_timezone,cron_command,cron_timeout_seconds,next_cron_at
      )
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        serviceId, projectId, parsed.data.name, parsed.data.kind, parsed.data.repoFullName, parsed.data.branch,
        parsed.data.buildType, parsed.data.internalPort, parsed.data.healthPath,
        parsed.data.cronExpression ?? null, parsed.data.cronTimezone, parsed.data.cronCommand ?? null,
        parsed.data.cronTimeoutSeconds, nextCron
      ]
    );
    if (parsed.data.domain) {
      await client.query("INSERT INTO domains(id,service_id,hostname) VALUES($1,$2,$3)", [id("dom"), serviceId, parsed.data.domain.toLowerCase()]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await audit(req.userId ?? "unknown", "project.create", "project", projectId, { repo: parsed.data.repoFullName });
  res.status(201).json({ id: projectId, serviceId });
});

app.post("/api/projects/:id/services", auth, async (req: AuthedRequest, res) => {
  const projectId = String(req.params.id);
  const project = await one<any>("SELECT id,name FROM projects WHERE id=$1", [projectId]);
  if (!project) return res.status(404).json({ error: "project not found" });

  const parsed = z.object({
    name: z.string().min(1).max(80),
    repoFullName: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    branch: z.string().min(1).default("main"),
    domain: z.string().min(3).optional(),
    kind: z.enum(["web","worker","cron"]).default("web"),
    buildType: z.enum(["auto","docker","node","python","static"]).default("auto"),
    internalPort: z.number().int().min(1).max(65535).default(3000),
    healthPath: z.string().startsWith("/").default("/"),
    cronExpression: z.string().min(1).optional(),
    cronTimezone: z.string().min(1).default("UTC"),
    cronCommand: z.string().min(1).optional(),
    cronTimeoutSeconds: z.number().int().min(1).max(86400).default(900)
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  if (parsed.data.kind === "cron") {
    if (!parsed.data.cronExpression || !parsed.data.cronCommand) {
      return res.status(400).json({ error: "cron services require cronExpression and cronCommand" });
    }
    const cronError = validateCron(parsed.data.cronExpression, parsed.data.cronTimezone);
    if (cronError) return res.status(400).json({ error: `invalid cron schedule: ${cronError}` });
  }

  const serviceId = id("svc");
  const nextCron = parsed.data.kind === "cron" && parsed.data.cronExpression
    ? nextCronAt(parsed.data.cronExpression, parsed.data.cronTimezone, new Date(), serviceId)
    : null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO services(
        id,project_id,name,kind,repo_full_name,branch,build_type,internal_port,health_path,
        cron_expression,cron_timezone,cron_command,cron_timeout_seconds,next_cron_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        serviceId,projectId,parsed.data.name,parsed.data.kind,parsed.data.repoFullName,parsed.data.branch,
        parsed.data.buildType,parsed.data.internalPort,parsed.data.healthPath,
        parsed.data.cronExpression ?? null,parsed.data.cronTimezone,parsed.data.cronCommand ?? null,
        parsed.data.cronTimeoutSeconds,nextCron
      ]
    );
    if (parsed.data.domain) {
      await client.query(
        "INSERT INTO domains(id,service_id,hostname) VALUES($1,$2,$3)",
        [id("dom"),serviceId,parsed.data.domain.toLowerCase()]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  await audit(req.userId ?? "unknown","service.create","service",serviceId,{
    projectId,
    name:parsed.data.name,
    kind:parsed.data.kind,
    repo:parsed.data.repoFullName
  });
  res.status(201).json({ id:serviceId, projectId });
});

app.delete("/api/services/:id", auth, async (req: AuthedRequest, res) => {
  const serviceId = String(req.params.id);
  const service = await one<any>("SELECT * FROM services WHERE id=$1", [serviceId]);
  if (!service) return res.status(404).json({ error: "service not found" });

  const siblingCount = await one<{count:string}>(
    "SELECT count(*)::text count FROM services WHERE project_id=$1",
    [service.project_id]
  );
  if (Number(siblingCount?.count ?? 0) <= 1) {
    return res.status(409).json({ error:"cannot delete the last service; delete the project instead" });
  }

  const [databaseCount, volumeCount] = await Promise.all([
    one<{count:string}>("SELECT count(*)::text count FROM database_resources WHERE service_id=$1", [serviceId]),
    one<{count:string}>("SELECT count(*)::text count FROM volumes WHERE service_id=$1", [serviceId])
  ]);
  const databases = Number(databaseCount?.count ?? 0);
  const volumes = Number(volumeCount?.count ?? 0);
  if (databases > 0 || volumes > 0) {
    return res.status(409).json({
      error:"service contains stateful resources; remove/detach managed databases and persistent volumes before deleting the service",
      databases,
      volumes
    });
  }

  const active = await one<any>(`
    SELECT server_id FROM deployments
    WHERE service_id=$1 AND server_id IS NOT NULL
    ORDER BY created_at DESC LIMIT 1
  `, [serviceId]);

  let commandId: string | null = null;
  if (active?.server_id) {
    commandId = await enqueueAgentCommand(active.server_id,"STOP",{
      serviceId,
      serviceCleanup:true
    });
  }

  await pool.query("DELETE FROM services WHERE id=$1", [serviceId]);
  await audit(req.userId ?? "unknown","service.delete","service",serviceId,{
    projectId:service.project_id,
    name:service.name,
    commandQueued:Boolean(commandId)
  });
  res.json({
    ok:true,
    commandId,
    projectId:service.project_id,
    note:"Stateless service deleted; any running container is queued for removal."
  });
});

app.get("/api/projects/:id", auth, async (req, res) => {
  const project = await one<any>("SELECT * FROM projects WHERE id=$1", [String(req.params.id)]);
  if (!project) return res.status(404).json({ error: "not found" });
  const services = await query<any>("SELECT * FROM services WHERE project_id=$1 ORDER BY created_at", [project.id]);
  for (const service of services) {
    service.domains = await query("SELECT * FROM domains WHERE service_id=$1 ORDER BY hostname", [service.id]);
    service.variables = await query("SELECT id,key,is_secret,created_at,updated_at FROM variables WHERE service_id=$1 ORDER BY key", [service.id]);
    service.volumes = await query("SELECT * FROM volumes WHERE service_id=$1 ORDER BY created_at", [service.id]);
    service.deployments = await query("SELECT * FROM deployments WHERE service_id=$1 ORDER BY created_at DESC LIMIT 30", [service.id]);
    service.health = await one("SELECT * FROM service_health WHERE service_id=$1", [service.id]);
    service.cron_runs = service.kind === "cron"
      ? await query("SELECT * FROM cron_runs WHERE service_id=$1 ORDER BY scheduled_for DESC LIMIT 50", [service.id])
      : [];
  }
  const databases = await query(`
    SELECT id,project_id,service_id,kind,name,docker_name,volume_name,server_id,username,database_name,variable_key,
      status,last_health_at,health_message,consecutive_failures,created_at,updated_at
    FROM database_resources WHERE project_id=$1 ORDER BY created_at
  `, [project.id]);
  res.json({ ...project, services, databases });
});

app.delete("/api/projects/:id", auth, async (req: AuthedRequest, res) => {
  const projectId = String(req.params.id);
  const project = await one<any>("SELECT * FROM projects WHERE id=$1", [projectId]);
  if (!project) return res.status(404).json({ error: "not found" });

  const [databaseCount, volumeCount] = await Promise.all([
    one<{count:string}>("SELECT count(*)::text count FROM database_resources WHERE project_id=$1", [projectId]),
    one<{count:string}>(`
      SELECT count(*)::text count
      FROM volumes v JOIN services s ON s.id=v.service_id
      WHERE s.project_id=$1
    `, [projectId])
  ]);
  const databases = Number(databaseCount?.count ?? 0);
  const volumes = Number(volumeCount?.count ?? 0);
  if (databases > 0 || volumes > 0) {
    return res.status(409).json({
      error: "project contains stateful resources; detach/delete managed databases and detach persistent volumes before deleting the project",
      databases,
      volumes
    });
  }

  const services = await query<any>(`
    SELECT s.id,
      (SELECT d.server_id FROM deployments d WHERE d.service_id=s.id AND d.server_id IS NOT NULL ORDER BY d.created_at DESC LIMIT 1) server_id
    FROM services s WHERE s.project_id=$1
  `, [projectId]);
  const commands: string[] = [];

  for (const service of services) {
    if (service.server_id) {
      commands.push(await enqueueAgentCommand(service.server_id, "STOP", { serviceId:service.id, projectCleanup:true }));
    }
  }

  await pool.query("DELETE FROM projects WHERE id=$1", [projectId]);
  await audit(req.userId ?? "unknown", "project.delete", "project", projectId, {
    name: project.name,
    queuedCleanupCommands: commands.length,
    statefulResourceCounts: { databases, volumes }
  });
  res.json({ ok: true, cleanupCommands:commands, note:"Stateless project deleted; managed service containers are queued for removal." });
});

app.patch("/api/services/:id", auth, async (req: AuthedRequest, res) => {
  const parsed = z.object({
    branch: z.string().min(1).optional(),
    rootDirectory: z.string().min(1).optional(),
    buildType: z.enum(["auto", "docker", "node", "python", "static"]).optional(),
    buildCommand: z.string().nullable().optional(),
    startCommand: z.string().nullable().optional(),
    predeployCommand: z.string().nullable().optional(),
    internalPort: z.number().int().min(1).max(65535).optional(),
    healthPath: z.string().startsWith("/").optional(),
    cpuLimit: z.number().positive().max(32).optional(),
    memoryMb: z.number().int().min(64).max(131072).optional(),
    autoDeploy: z.boolean().optional(),
    kind: z.enum(["web","worker","cron"]).optional(),
    cronExpression: z.string().min(1).nullable().optional(),
    cronTimezone: z.string().min(1).optional(),
    cronCommand: z.string().min(1).nullable().optional(),
    cronTimeoutSeconds: z.number().int().min(1).max(86400).optional()
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const currentService = await one<any>("SELECT * FROM services WHERE id=$1", [String(req.params.id)]);
  if (!currentService) return res.status(404).json({ error: "not found" });
  const effectiveKind = parsed.data.kind ?? currentService.kind;
  const effectiveExpression = parsed.data.cronExpression === undefined ? currentService.cron_expression : parsed.data.cronExpression;
  const effectiveTimezone = parsed.data.cronTimezone ?? currentService.cron_timezone ?? "UTC";
  const effectiveCommand = parsed.data.cronCommand === undefined ? currentService.cron_command : parsed.data.cronCommand;
  if (effectiveKind === "cron") {
    if (!effectiveExpression || !effectiveCommand) {
      return res.status(400).json({ error: "cron services require cronExpression and cronCommand" });
    }
    const cronError = validateCron(effectiveExpression, effectiveTimezone, currentService.id);
    if (cronError) return res.status(400).json({ error: `invalid cron schedule: ${cronError}` });
  }

  const mapping: Record<string,string> = {
    branch:"branch", rootDirectory:"root_directory", buildType:"build_type", buildCommand:"build_command",
    startCommand:"start_command", predeployCommand:"predeploy_command", internalPort:"internal_port",
    healthPath:"health_path", cpuLimit:"cpu_limit", memoryMb:"memory_mb", autoDeploy:"auto_deploy",
    kind:"kind", cronExpression:"cron_expression", cronTimezone:"cron_timezone",
    cronCommand:"cron_command", cronTimeoutSeconds:"cron_timeout_seconds"
  };
  const entries = Object.entries(parsed.data);
  if (!entries.length) return res.json({ ok: true });
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of entries) {
    values.push(value);
    sets.push(`${mapping[key]}=$${values.length}`);
  }
  values.push(String(req.params.id));
  const idPlaceholder = "$" + values.length;
  const result = await pool.query(
    `UPDATE services SET ${sets.join(",")}, updated_at=now() WHERE id=${idPlaceholder} RETURNING *`,
    values
  );
  if (!result.rowCount) return res.status(404).json({ error: "not found" });

  const updatedService = result.rows[0];
  if (updatedService.kind === "cron" && updatedService.cron_expression) {
    const nextRun = nextCronAt(updatedService.cron_expression, updatedService.cron_timezone || "UTC", new Date(), updatedService.id);
    await pool.query("UPDATE services SET next_cron_at=$2 WHERE id=$1", [updatedService.id, nextRun]);
    updatedService.next_cron_at = nextRun;
  } else {
    await pool.query("UPDATE services SET next_cron_at=NULL WHERE id=$1", [updatedService.id]);
    updatedService.next_cron_at = null;
  }
  await audit(req.userId ?? "unknown", "service.update", "service", String(req.params.id), parsed.data);
  res.json(result.rows[0]);
});

app.post("/api/services/:id/maintenance", auth, async (req: AuthedRequest, res) => {
  const serviceId = String(req.params.id);
  const parsed = z.object({
    enabled: z.boolean(),
    message: z.string().min(1).max(1000).optional()
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const service = await one<any>("SELECT * FROM services WHERE id=$1", [serviceId]);
  if (!service) return res.status(404).json({ error: "service not found" });
  if (service.kind !== "web") {
    return res.status(409).json({ error: "maintenance mode is available only for web services" });
  }

  const message = parsed.data.message ?? service.maintenance_message ??
    "We are performing scheduled maintenance. Please try again shortly.";

  await pool.query(
    "UPDATE services SET maintenance_enabled=$2,maintenance_message=$3,updated_at=now() WHERE id=$1",
    [serviceId,parsed.data.enabled,message]
  );

  const active = await one<any>(`
    SELECT server_id FROM deployments
    WHERE service_id=$1 AND server_id IS NOT NULL AND status IN ('RUNNING','UNHEALTHY')
    ORDER BY created_at DESC LIMIT 1
  `, [serviceId]);

  const domains = await query<{hostname:string}>(
    "SELECT hostname FROM domains WHERE service_id=$1 AND verified=true ORDER BY hostname",
    [serviceId]
  );

  let commandId: string | null = null;
  if (active?.server_id) {
    commandId = await enqueueAgentCommand(active.server_id,"MAINTENANCE",{
      serviceId,
      enabled:parsed.data.enabled,
      message,
      domains:domains.map((domain)=>domain.hostname)
    });
  }

  await audit(req.userId ?? "unknown",
    parsed.data.enabled ? "service.maintenance.enabled" : "service.maintenance.disabled",
    "service",
    serviceId,
    { message,commandQueued:Boolean(commandId) }
  );

  res.status(commandId ? 202 : 200).json({
    enabled:parsed.data.enabled,
    message,
    commandId,
    note:commandId
      ? "Maintenance route change queued."
      : "Maintenance state saved. It will be honored on the next web deployment."
  });
});

app.post("/api/services/:id/deploy", auth, async (req: AuthedRequest, res) => {
  const service = await one<any>("SELECT * FROM services WHERE id=$1", [String(req.params.id)]);
  if (!service) return res.status(404).json({ error: "service not found" });

  const parsed = z.object({
    commitSha: z.string().regex(/^[0-9a-f]{40}$/i).optional()
  }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "commitSha must be a full 40-character Git SHA" });

  const deploymentId = await createDeployment(
    service.id,
    parsed.data.commitSha ? "manual-commit" : "manual",
    undefined,
    undefined,
    undefined,
    undefined,
    parsed.data.commitSha ?? null
  );
  await audit(req.userId ?? "unknown", "deployment.create", "deployment", deploymentId, {
    serviceId: service.id,
    commitSha: parsed.data.commitSha ?? null
  });
  res.status(202).json({ deploymentId });
});

app.post("/api/deployments/:id/rollback", auth, async (req: AuthedRequest, res) => {
  const target = await one<any>(
    "SELECT d.*, s.id service_id FROM deployments d JOIN services s ON s.id=d.service_id WHERE d.id=$1 AND d.image_ref IS NOT NULL",
    [String(req.params.id)]
  );
  if (!target) return res.status(404).json({ error: "deployable target not found" });
  const deploymentId = await createDeployment(
    target.service_id,
    "rollback",
    target.image_ref,
    target.id,
    target.runtime_port,
    target.detected_build_type
  );
  await audit(req.userId ?? "unknown", "deployment.rollback", "deployment", deploymentId, { target: target.id });
  res.status(202).json({ deploymentId });
});

app.get("/api/deployments", auth, async (_req, res) => {
  const rows = await query<any>(`
    SELECT d.*, s.name service_name, p.name project_name
    FROM deployments d
    JOIN services s ON s.id=d.service_id
    JOIN projects p ON p.id=s.project_id
    ORDER BY d.created_at DESC LIMIT 200
  `);
  res.json(rows);
});

app.post("/api/deployments/:id/cancel", auth, async (req: AuthedRequest, res) => {
  const deploymentId = String(req.params.id);
  const deployment = await one<any>("SELECT * FROM deployments WHERE id=$1", [deploymentId]);
  if (!deployment) return res.status(404).json({ error: "deployment not found" });
  if (deployment.status !== "QUEUED") {
    return res.status(409).json({ error: "only queued deployments can be cancelled safely; stop the service separately if needed" });
  }

  const job = await deploymentQueue.getJob(deploymentId);
  if (job) await job.remove().catch(() => {});

  await pool.query(
    "UPDATE deployments SET status='CANCELLED',failure_reason='Cancelled by operator',completed_at=now() WHERE id=$1 AND status='QUEUED'",
    [deploymentId]
  );
  await audit(req.userId ?? "unknown", "deployment.cancel", "deployment", deploymentId);
  res.json({ ok:true });
});

app.get("/api/services/:id/cron-runs", auth, async (req, res) => {
  const serviceId=String(req.params.id);
  const service=await one<any>("SELECT id,kind FROM services WHERE id=$1",[serviceId]);
  if(!service) return res.status(404).json({error:"service not found"});
  if(service.kind!=="cron") return res.status(409).json({error:"service is not a cron service"});
  res.json(await query(
    "SELECT * FROM cron_runs WHERE service_id=$1 ORDER BY scheduled_for DESC LIMIT 200",
    [serviceId]
  ));
});

app.post("/api/services/:id/cron/run", auth, async (req: AuthedRequest, res) => {
  const service=await one<any>("SELECT * FROM services WHERE id=$1",[String(req.params.id)]);
  if(!service) return res.status(404).json({error:"service not found"});
  if(service.kind!=="cron") return res.status(409).json({error:"service is not a cron service"});
  if(!service.cron_command) return res.status(409).json({error:"cron command is not configured"});
  const queued=await queueCronRun(service,new Date(),"manual");
  if(!queued) return res.status(409).json({error:"duplicate cron run timestamp"});
  await audit(req.userId ?? "unknown","cron.run.manual","service",service.id,{runId:queued.runId});
  res.status(202).json(queued);
});

app.get("/api/deployments/:id/logs", auth, async (req, res) => {
  const after = Number(req.query.after ?? 0);
  const rows = await query("SELECT * FROM deployment_logs WHERE deployment_id=$1 AND id>$2 ORDER BY id LIMIT 1000", [String(req.params.id), after]);
  res.json(rows);
});

app.get("/api/services/:id/variables", auth, async (req, res) => {
  const rows = await query("SELECT id,key,is_secret,created_at,updated_at FROM variables WHERE service_id=$1 ORDER BY key", [String(req.params.id)]);
  res.json(rows);
});

app.put("/api/services/:id/variables/:key", auth, async (req: AuthedRequest, res) => {
  const value = req.body?.value;
  if (typeof value !== "string") return res.status(400).json({ error: "value must be a string" });
  const keyName = String(req.params.key).toUpperCase();
  if (!/^[A-Z_][A-Z0-9_]*$/.test(keyName)) return res.status(400).json({ error: "invalid variable key" });
  const rowId = id("var");
  await pool.query(
    `INSERT INTO variables(id,service_id,key,value_enc,is_secret) VALUES($1,$2,$3,$4,true)
     ON CONFLICT(service_id,key) DO UPDATE SET value_enc=excluded.value_enc, updated_at=now()`,
    [rowId, String(req.params.id), keyName, encryptSecret(value)]
  );
  await audit(req.userId ?? "unknown", "variable.set", "service", String(req.params.id), { key: keyName });
  res.json({ key: keyName, saved: true });
});

app.delete("/api/services/:id/variables/:key", auth, async (req: AuthedRequest, res) => {
  await pool.query("DELETE FROM variables WHERE service_id=$1 AND key=$2", [String(req.params.id), String(req.params.key).toUpperCase()]);
  await audit(req.userId ?? "unknown", "variable.delete", "service", String(req.params.id), { key: req.params.key });
  res.json({ ok: true });
});

app.post("/api/services/:id/domains", auth, async (req: AuthedRequest, res) => {
  const hostname = String(req.body?.hostname ?? "").toLowerCase().trim();
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname)) {
    return res.status(400).json({ error: "invalid hostname" });
  }
  const domainId = id("dom");
  await pool.query("INSERT INTO domains(id,service_id,hostname) VALUES($1,$2,$3)", [domainId, String(req.params.id), hostname]);
  await audit(req.userId ?? "unknown", "domain.add", "service", String(req.params.id), { hostname });
  res.status(201).json({ id: domainId, hostname });
});

app.post("/api/domains/:id/verify", auth, async (req, res) => {
  const domain = await one<any>("SELECT * FROM domains WHERE id=$1", [String(req.params.id)]);
  if (!domain) return res.status(404).json({ error: "not found" });
  const expectedIp = optionalEnv("PUBLIC_IP");
  const expectedHost = optionalEnv("PLATFORM_HOST");
  if (!expectedIp && !expectedHost) return res.status(503).json({ error: "configure PUBLIC_IP or PLATFORM_HOST to verify domains" });

  let verified = false;
  const evidence: Record<string, unknown> = {};
  try {
    const addresses = await dns.resolve4(domain.hostname);
    evidence.a = addresses;
    if (expectedIp && addresses.includes(expectedIp)) verified = true;
  } catch {}
  try {
    const cnames = await dns.resolveCname(domain.hostname);
    evidence.cname = cnames;
    if (expectedHost && cnames.some((v) => v.replace(/\.$/, "") === expectedHost.replace(/\.$/, ""))) verified = true;
  } catch {}
  await pool.query(
    "UPDATE domains SET verified=$1, verified_at=CASE WHEN $1 THEN now() ELSE NULL END, verification_error=$2 WHERE id=$3",
    [verified, verified ? null : "DNS does not point at this platform", domain.id]
  );
  res.status(verified ? 200 : 409).json({ verified, evidence, expectedIp, expectedHost });
});

app.delete("/api/domains/:id", auth, async (req: AuthedRequest, res) => {
  const domain = await one<any>("SELECT * FROM domains WHERE id=$1", [String(req.params.id)]);
  if (!domain) return res.status(404).json({ error: "domain not found" });

  await pool.query("DELETE FROM domains WHERE id=$1", [domain.id]);

  const active = await one<any>(`
    SELECT id,server_id FROM deployments
    WHERE service_id=$1 AND server_id IS NOT NULL AND status='RUNNING'
    ORDER BY created_at DESC LIMIT 1
  `, [domain.service_id]);

  let commandId: string | null = null;
  if (active?.server_id) {
    const domains = await query<{hostname:string}>(
      "SELECT hostname FROM domains WHERE service_id=$1 AND verified=true ORDER BY hostname",
      [domain.service_id]
    );
    commandId = await enqueueAgentCommand(active.server_id, "REFRESH_ROUTE", {
      serviceId: domain.service_id,
      domains: domains.map((item) => item.hostname)
    }, active.id);
  }

  await audit(req.userId ?? "unknown", "domain.delete", "domain", domain.id, {
    hostname: domain.hostname,
    serviceId: domain.service_id
  });
  res.status(commandId ? 202 : 200).json({ ok:true, commandId });
});

app.get("/api/servers", auth, async (_req, res) => {
  const rows = await query("SELECT *, (last_seen_at > now() - interval '45 seconds') AS online FROM servers ORDER BY name");
  res.json(rows);
});

app.post("/api/servers/:id/drain", auth, async (req: AuthedRequest, res) => {
  const draining = Boolean(req.body?.draining);
  const result = await pool.query(
    "UPDATE servers SET draining=$2 WHERE id=$1 RETURNING *",
    [String(req.params.id),draining]
  );
  if(!result.rowCount) return res.status(404).json({error:"server not found"});
  await audit(req.userId ?? "unknown", draining ? "server.drain" : "server.resume", "server", String(req.params.id));
  res.json(result.rows[0]);
});

app.get("/api/audit", auth, async (_req, res) => {
  res.json(await query("SELECT * FROM audit_events ORDER BY id DESC LIMIT 300"));
});

app.get("/api/alerts", auth, async (_req, res) => {
  res.json(await query("SELECT * FROM alerts ORDER BY resolved_at NULLS FIRST, created_at DESC LIMIT 300"));
});

app.post("/api/alerts/:id/resolve", auth, async (req: AuthedRequest, res) => {
  const result = await pool.query("UPDATE alerts SET resolved_at=now() WHERE id=$1 RETURNING *", [String(req.params.id)]);
  if (!result.rowCount) return res.status(404).json({ error: "alert not found" });
  await audit(req.userId ?? "unknown", "alert.resolve", "alert", String(req.params.id));
  res.json(result.rows[0]);
});

app.get("/api/backups", auth, async (_req, res) => {
  res.json(await query(`
    SELECT b.*, v.name volume_name, p.name project_name, s.name service_name
    FROM backups b
    LEFT JOIN volumes v ON v.id=b.volume_id
    LEFT JOIN services s ON s.id=b.service_id
    LEFT JOIN projects p ON p.id=s.project_id
    ORDER BY b.created_at DESC LIMIT 200
  `));
});

app.get("/api/databases", auth, async (_req, res) => {
  res.json(await query(`
    SELECT d.id,d.project_id,d.service_id,d.kind,d.name,d.docker_name,d.volume_name,d.server_id,d.username,d.database_name,d.variable_key,
      d.status,d.last_health_at,d.health_message,d.consecutive_failures,d.created_at,d.updated_at,
      p.name project_name
    FROM database_resources d JOIN projects p ON p.id=d.project_id
    ORDER BY d.created_at DESC
  `));
});

app.post("/api/projects/:id/databases", auth, async (req: AuthedRequest, res) => {
  const parsed = z.object({
    kind: z.enum(["postgres","redis"]),
    name: z.string().min(1).max(60),
    serviceId: z.string().optional(),
    variableKey: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional()
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const projectId = String(req.params.id);
  const project = await one<any>("SELECT id FROM projects WHERE id=$1", [projectId]);
  if (!project) return res.status(404).json({ error: "project not found" });

  let service: any = null;
  if (parsed.data.serviceId) {
    service = await one<any>("SELECT id FROM services WHERE id=$1 AND project_id=$2", [parsed.data.serviceId,projectId]);
    if (!service) return res.status(400).json({ error: "service does not belong to project" });
  }

  let server: any = null;
  if (service) {
    server = await one<any>(`
      SELECT sv.id,sv.name FROM deployments d
      JOIN servers sv ON sv.id=d.server_id
      WHERE d.service_id=$1 AND sv.draining=false AND sv.last_seen_at > now() - interval '45 seconds'
      ORDER BY d.created_at DESC LIMIT 1
    `, [service.id]);
  }
  if (!server) {
    const preferred = optionalEnv("SERVER_ID");
    if (preferred) {
      server = await one<any>("SELECT id,name FROM servers WHERE id=$1 AND draining=false AND last_seen_at > now() - interval '45 seconds'", [preferred]);
    }
  }
  if (!server) {
    server = await one<any>("SELECT id,name FROM servers WHERE draining=false AND last_seen_at > now() - interval '45 seconds' ORDER BY load1 ASC NULLS LAST LIMIT 1");
  }
  if (!server) return res.status(409).json({ error: "no online runtime server available" });

  const databaseId = id("db");
  const dockerName = `mr-db-${databaseId.slice(-10)}`;
  const volumeName = `${dockerName}-data`;
  const password = crypto.randomBytes(24).toString("base64url");
  const username = parsed.data.kind === "postgres" ? "mruser" : null;
  const databaseName = parsed.data.kind === "postgres" ? "app" : null;
  const variableKey = parsed.data.variableKey ?? (parsed.data.kind === "postgres" ? "DATABASE_URL" : "REDIS_URL");

  await pool.query(
    `INSERT INTO database_resources(id,project_id,service_id,kind,name,docker_name,volume_name,server_id,username,password_enc,database_name,variable_key,status)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'queued')`,
    [databaseId,projectId,service?.id ?? null,parsed.data.kind,parsed.data.name,dockerName,volumeName,server.id,username,encryptSecret(password),databaseName,variableKey]
  );

  if (service) {
    const connection = managedDatabaseConnection({
      kind:parsed.data.kind,username,docker_name:dockerName,database_name:databaseName
    },password);
    await pool.query(
      `INSERT INTO variables(id,service_id,key,value_enc,is_secret) VALUES($1,$2,$3,$4,true)
       ON CONFLICT(service_id,key) DO UPDATE SET value_enc=excluded.value_enc,updated_at=now()`,
      [id("var"),service.id,variableKey,encryptSecret(connection)]
    );
  }

  const commandId = await enqueueAgentCommand(server.id,"PROVISION_DATABASE",{
    databaseId,kind:parsed.data.kind,dockerName,volumeName,username,password,databaseName
  });
  await audit(req.userId ?? "unknown","database.create","database",databaseId,{kind:parsed.data.kind,projectId,serviceId:service?.id ?? null});
  res.status(202).json({ databaseId,commandId,variableKey,server:{id:server.id,name:server.name} });
});

app.delete("/api/databases/:id", auth, async (req: AuthedRequest, res) => {
  const database = await one<any>("SELECT * FROM database_resources WHERE id=$1", [String(req.params.id)]);
  if(!database) return res.status(404).json({error:"database not found"});
  const deleteData = req.body?.confirm === "DELETE_DATA";
  if (database.status === "deleting") return res.status(409).json({error:"database deletion is already in progress"});
  const commandId = await enqueueAgentCommand(database.server_id,"REMOVE_DATABASE",{
    databaseId:database.id,dockerName:database.docker_name,volumeName:database.volume_name,
    deleteData,serviceId:database.service_id
  });
  await pool.query("UPDATE database_resources SET status='deleting',updated_at=now() WHERE id=$1",[database.id]);
  await audit(req.userId ?? "unknown","database.delete.requested","database",database.id,{deleteData,commandId});
  res.status(202).json({
    commandId,
    dataDeleted:deleteData,
    note:deleteData ? "Database deletion is queued; metadata will be removed only after the runtime confirms container and data-volume deletion." : "Database detach is queued; the app will be stopped and the encrypted database record plus data volume will be retained for reattachment."
  });
});

app.post("/api/databases/:id/reattach", auth, async (req: AuthedRequest, res) => {
  const database = await one<any>("SELECT * FROM database_resources WHERE id=$1", [String(req.params.id)]);
  if (!database) return res.status(404).json({ error:"database not found" });
  if (!["detached","delete_failed","failed"].includes(database.status)) {
    return res.status(409).json({ error:`database cannot be reattached from status ${database.status}` });
  }

  const server = await one<any>(
    "SELECT id,name,draining FROM servers WHERE id=$1 AND last_seen_at > now()-interval '45 seconds'",
    [database.server_id]
  );
  if (!server) return res.status(409).json({ error:"the database's runtime server is offline" });
  if (server.draining) return res.status(409).json({ error:"the database's runtime server is draining" });

  const password = decryptSecret(database.password_enc);
  if (database.service_id && database.variable_key) {
    const connection = managedDatabaseConnection(database,password);
    await pool.query(
      `INSERT INTO variables(id,service_id,key,value_enc,is_secret) VALUES($1,$2,$3,$4,true)
       ON CONFLICT(service_id,key) DO UPDATE SET value_enc=excluded.value_enc,updated_at=now()`,
      [id("var"),database.service_id,database.variable_key,encryptSecret(connection)]
    );
  }

  const commandId = await enqueueAgentCommand(database.server_id,"PROVISION_DATABASE",{
    databaseId:database.id,
    kind:database.kind,
    dockerName:database.docker_name,
    volumeName:database.volume_name,
    username:database.username,
    password,
    databaseName:database.database_name
  });
  await pool.query(
    "UPDATE database_resources SET status='queued',health_message='Reattach queued',updated_at=now() WHERE id=$1",
    [database.id]
  );
  await resolveAlert(`database-delete:${database.id}`);
  await audit(req.userId ?? "unknown","database.reattach","database",database.id,{commandId});
  res.status(202).json({
    commandId,
    note:"Database reattach queued. Redeploy the attached application after the database reports running."
  });
});

app.post("/api/databases/:id/backup", auth, async (req: AuthedRequest, res) => {
  const database = await one<any>("SELECT * FROM database_resources WHERE id=$1", [String(req.params.id)]);
  if (!database) return res.status(404).json({ error: "database not found" });
  if (database.status !== "running") return res.status(409).json({ error: "database is not running" });

  const backupId=id("bak");
  await pool.query(
    "INSERT INTO backups(id,service_id,database_id,server_id,kind,status) VALUES($1,$2,$3,$4,$5,'queued')",
    [backupId,database.service_id,database.id,database.server_id,`database-${database.kind}`]
  );
  const commandId=await enqueueAgentCommand(database.server_id,"BACKUP_DATABASE",{
    databaseId:database.id,kind:database.kind,dockerName:database.docker_name,volumeName:database.volume_name,
    username:database.username,password:decryptSecret(database.password_enc),databaseName:database.database_name,
    backupId,backupName:backupId
  });
  await audit(req.userId ?? "unknown","database.backup","database",database.id,{backupId});
  res.status(202).json({backupId,commandId});
});

app.post("/api/backups/:id/restore-database", auth, async (req: AuthedRequest, res) => {
  if (req.body?.confirm !== "RESTORE_DATABASE") {
    return res.status(400).json({ error: "destructive database restore requires confirm=RESTORE_DATABASE" });
  }
  const backup=await one<any>(`
    SELECT b.*,d.kind database_kind,d.docker_name,d.volume_name,d.username,d.password_enc,d.database_name,d.service_id
    FROM backups b JOIN database_resources d ON d.id=b.database_id
    WHERE b.id=$1
  `,[String(req.params.id)]);
  if(!backup || backup.status!=="completed" || !backup.location) {
    return res.status(409).json({ error:"completed database backup is required" });
  }
  const commandId=await enqueueAgentCommand(backup.server_id,"RESTORE_DATABASE",{
    databaseId:backup.database_id,kind:backup.database_kind,dockerName:backup.docker_name,volumeName:backup.volume_name,
    username:backup.username,password:decryptSecret(backup.password_enc),databaseName:backup.database_name,
    serviceId:backup.service_id,fileName:path.basename(backup.location),backupId:backup.id
  });
  await audit(req.userId ?? "unknown","database.restore","backup",backup.id,{databaseId:backup.database_id});
  res.status(202).json({commandId,note:"Attached application service will be stopped before restore; redeploy it after completion."});
});

app.get("/api/services/:id/volumes", auth, async (req, res) => {
  res.json(await query("SELECT * FROM volumes WHERE service_id=$1 ORDER BY created_at", [String(req.params.id)]));
});

app.post("/api/services/:id/volumes", auth, async (req: AuthedRequest, res) => {
  const parsed = z.object({
    name: z.string().min(1).max(60),
    mountPath: z.string().startsWith("/").max(250),
    readOnly: z.boolean().default(false)
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const serviceId = String(req.params.id);
  const service = await one<any>("SELECT id FROM services WHERE id=$1", [serviceId]);
  if (!service) return res.status(404).json({ error: "service not found" });
  const volumeId = id("vol");
  const dockerName = `mr-${serviceId.slice(-10)}-${slug(parsed.data.name)}`;
  await pool.query(
    "INSERT INTO volumes(id,service_id,name,docker_volume_name,mount_path,read_only) VALUES($1,$2,$3,$4,$5,$6)",
    [volumeId, serviceId, parsed.data.name, dockerName, parsed.data.mountPath, parsed.data.readOnly]
  );
  await audit(req.userId ?? "unknown", "volume.attach", "service", serviceId, { name: parsed.data.name, mountPath: parsed.data.mountPath });
  res.status(201).json({ id: volumeId, dockerVolumeName: dockerName });
});

app.delete("/api/volumes/:id", auth, async (req: AuthedRequest, res) => {
  const volume = await one<any>("SELECT * FROM volumes WHERE id=$1", [String(req.params.id)]);
  if (!volume) return res.status(404).json({ error: "volume not found" });
  if (volume.status === "deleting") return res.status(409).json({ error: "volume deletion is already in progress" });

  const deleteData = req.body?.confirm === "DELETE_DATA";
  const active = await one<any>(`
    SELECT server_id FROM deployments
    WHERE service_id=$1 AND server_id IS NOT NULL
    ORDER BY created_at DESC LIMIT 1
  `, [volume.service_id]);

  if (!active?.server_id) {
    if (deleteData) {
      await pool.query("DELETE FROM volumes WHERE id=$1", [volume.id]);
      await audit(req.userId ?? "unknown","volume.delete.completed","volume",volume.id,{
        deleteData:true,
        runtimeCommand:false
      });
      return res.json({ ok:true, dataDeleted:true, note:"Volume metadata removed. No runtime placement existed, so there was no Docker-host cleanup to queue." });
    }

    await pool.query(
      "UPDATE volumes SET status='detached',detached_at=now() WHERE id=$1",
      [volume.id]
    );
    await audit(req.userId ?? "unknown","volume.detach.completed","volume",volume.id,{
      deleteData:false,
      runtimeCommand:false
    });
    return res.json({ ok:true, dataDeleted:false, note:"Volume retained in detached state. Reattach it before the next deployment if you want it mounted again." });
  }

  const commandId = await enqueueAgentCommand(active.server_id,"REMOVE_VOLUME",{
    volumeId:volume.id,
    serviceId:volume.service_id,
    volumeName:volume.docker_volume_name,
    deleteData
  });
  await pool.query(
    "UPDATE volumes SET status='deleting' WHERE id=$1",
    [volume.id]
  );
  await audit(req.userId ?? "unknown","volume.delete.requested","volume",volume.id,{
    deleteData,
    commandId
  });
  res.status(202).json({
    commandId,
    dataDeleted:deleteData,
    note:deleteData
      ? "Volume deletion is queued; metadata will be removed after the runtime confirms Docker-volume deletion."
      : "Volume detach is queued; the service will stop and the Docker volume/data will be retained."
  });
});

app.post("/api/volumes/:id/reattach", auth, async (req: AuthedRequest, res) => {
  const volume = await one<any>("SELECT * FROM volumes WHERE id=$1", [String(req.params.id)]);
  if (!volume) return res.status(404).json({ error: "volume not found" });
  if (!["detached","delete_failed"].includes(volume.status)) {
    return res.status(409).json({ error: "only a detached or failed-detach volume can be reattached" });
  }

  const updated = await one<any>(
    "UPDATE volumes SET status='attached',detached_at=NULL WHERE id=$1 RETURNING *",
    [volume.id]
  );
  await resolveAlert(`volume-delete:${volume.id}`);
  await audit(req.userId ?? "unknown","volume.reattach","volume",volume.id,{
    serviceId:volume.service_id,
    mountPath:volume.mount_path
  });
  res.json({
    volume:updated,
    note:"Volume marked attached. Redeploy the service to mount it again."
  });
});

app.post("/api/volumes/:id/backup", auth, async (req: AuthedRequest, res) => {
  const volume = await one<any>(`
    SELECT v.*, s.id service_id
    FROM volumes v JOIN services s ON s.id=v.service_id
    WHERE v.id=$1
  `, [String(req.params.id)]);
  if (!volume) return res.status(404).json({ error: "volume not found" });
  if (volume.status === "deleting") return res.status(409).json({ error: "volume cleanup is in progress" });
  const active = await one<any>(`
    SELECT server_id FROM deployments
    WHERE service_id=$1 AND server_id IS NOT NULL
    ORDER BY created_at DESC LIMIT 1
  `, [volume.service_id]);
  if (!active?.server_id) return res.status(409).json({ error: "no runtime placement exists for this service" });
  const backupId = id("bak");
  await pool.query(
    "INSERT INTO backups(id,service_id,volume_id,server_id,kind,status) VALUES($1,$2,$3,$4,'volume','queued')",
    [backupId, volume.service_id, volume.id, active.server_id]
  );
  const commandId = await enqueueAgentCommand(active.server_id,"BACKUP_VOLUME",{
    volumeName: volume.docker_volume_name,
    backupName: backupId,
    backupId,
    serviceId: volume.service_id
  });
  await audit(req.userId ?? "unknown", "backup.create", "backup", backupId, { volumeId: volume.id });
  res.status(202).json({ backupId, commandId });
});

app.post("/api/backups/:id/test", auth, async (req: AuthedRequest, res) => {
  const backup = await one<any>("SELECT * FROM backups WHERE id=$1", [String(req.params.id)]);
  if (!backup || backup.status !== "completed" || !backup.location || !backup.server_id) {
    return res.status(409).json({ error: "completed backup with a runtime location is required" });
  }

  let action="TEST_VOLUME_BACKUP";
  let payload:any={backupId:backup.id,fileName:path.basename(backup.location)};
  if(backup.database_id){
    const database=await one<any>("SELECT kind,docker_name FROM database_resources WHERE id=$1",[backup.database_id]);
    if(!database) return res.status(404).json({error:"database resource not found"});
    action="TEST_DATABASE_BACKUP";
    payload={...payload,kind:database.kind,dockerName:database.docker_name};
  }
  const commandId=await enqueueAgentCommand(backup.server_id,action,payload);
  await audit(req.userId ?? "unknown", "backup.test", "backup", backup.id);
  res.status(202).json({ commandId });
});

app.post("/api/backups/:id/restore", auth, async (req: AuthedRequest, res) => {
  if (req.body?.confirm !== "RESTORE") {
    return res.status(400).json({ error: "destructive restore requires confirm=RESTORE" });
  }
  const backup = await one<any>(`
    SELECT b.*, v.docker_volume_name, v.service_id
    FROM backups b
    JOIN volumes v ON v.id=b.volume_id
    WHERE b.id=$1
  `, [String(req.params.id)]);
  if (!backup || backup.status !== "completed" || !backup.location || !backup.server_id) {
    return res.status(409).json({ error: "completed volume backup with a runtime location is required" });
  }
  const commandId = await enqueueAgentCommand(backup.server_id,"RESTORE_VOLUME",{
    backupId: backup.id,
    serviceId: backup.service_id,
    volumeName: backup.docker_volume_name,
    fileName: path.basename(backup.location)
  });
  await audit(req.userId ?? "unknown", "backup.restore", "backup", backup.id, { serviceId: backup.service_id });
  res.status(202).json({
    commandId,
    note: "The runtime agent will stop the service before restoring the volume. Redeploy the service after the command completes."
  });
});

async function sendServiceCommand(serviceId: string, action: "STOP"|"RESTART") {
  const active = await one<any>(`
    SELECT server_id FROM deployments
    WHERE service_id=$1 AND server_id IS NOT NULL
    ORDER BY created_at DESC LIMIT 1
  `, [serviceId]);
  if (!active?.server_id) return null;
  return enqueueAgentCommand(active.server_id,action,{ serviceId });
}

app.get("/api/commands/:id", auth, async (req, res) => {
  const command = await one<any>(`
    SELECT id,server_id,deployment_id,action,status,result,created_at,claimed_at,completed_at
    FROM agent_commands WHERE id=$1
  `, [String(req.params.id)]);
  if (!command) return res.status(404).json({ error: "command not found" });
  res.json(command);
});

app.post("/api/services/:id/logs/refresh", auth, async (req: AuthedRequest, res) => {
  const serviceId = String(req.params.id);
  const active = await one<any>(`
    SELECT id,server_id FROM deployments
    WHERE service_id=$1 AND server_id IS NOT NULL
    ORDER BY created_at DESC LIMIT 1
  `, [serviceId]);
  if (!active?.server_id) return res.status(409).json({ error: "service has never been assigned to a runtime server" });
  const commandId = await enqueueAgentCommand(active.server_id,"FETCH_LOGS",{ serviceId },active.id);
  await audit(req.userId ?? "unknown", "runtime.logs.refresh", "service", serviceId);
  res.status(202).json({ commandId, deploymentId: active.id });
});

app.get("/api/platform/readiness", auth, async (_req, res) => {
  type Check = {
    id: string;
    title: string;
    status: "pass"|"warning"|"blocker";
    message: string;
  };
  const checks: Check[] = [];
  const add = (id:string,title:string,status:Check["status"],message:string) => checks.push({id,title,status,message});

  const user = await one<any>("SELECT email,totp_enabled FROM users ORDER BY created_at LIMIT 1");
  add(
    "admin",
    "Administrator account",
    user ? "pass" : "blocker",
    user ? `Administrator exists: ${user.email}` : "Create the first administrator account."
  );
  add(
    "totp",
    "Two-factor authentication",
    user?.totp_enabled ? "pass" : "blocker",
    user?.totp_enabled ? "TOTP is enabled." : "Enable TOTP and store recovery codes before production use."
  );

  const sessionSecret = optionalEnv("SESSION_SECRET") ?? "";
  const encryptionKey = optionalEnv("SECRET_ENCRYPTION_KEY") ?? "";
  const agentSecret = optionalEnv("AGENT_TOKEN") ?? "";
  const updaterSecret = optionalEnv("PLATFORM_UPDATER_TOKEN") ?? "";
  const webhookSecret = optionalEnv("GITHUB_WEBHOOK_SECRET") ?? "";
  let encryptionKeyBytes = 0;
  try { encryptionKeyBytes = Buffer.from(encryptionKey,"base64").length; } catch {}
  const coreSecretsOk =
    sessionSecret.length >= 32 &&
    encryptionKeyBytes === 32 &&
    agentSecret.length >= 32 &&
    updaterSecret.length >= 32 &&
    webhookSecret.length >= 32 &&
    webhookSecret !== "replace-me";
  add(
    "core-secrets",
    "Platform secrets",
    coreSecretsOk ? "pass" : "blocker",
    coreSecretsOk ? "Core platform secrets are populated." : "One or more required platform secrets are missing, placeholder, or too short."
  );

  const githubAppConfigured = Boolean(
    optionalEnv("GITHUB_APP_ID") &&
    optionalEnv("GITHUB_APP_INSTALLATION_ID") &&
    optionalEnv("GITHUB_APP_PRIVATE_KEY_BASE64")
  );
  const githubPatConfigured = Boolean(optionalEnv("GITHUB_TOKEN"));
  add(
    "github-source",
    "GitHub repository access",
    githubAppConfigured ? "pass" : githubPatConfigured ? "warning" : "blocker",
    githubAppConfigured
      ? "GitHub App credentials are configured."
      : githubPatConfigured
        ? "A static GitHub token is configured; GitHub App authentication is preferred."
        : "Configure a GitHub App (preferred) or a fallback GitHub token."
  );

  const platformHost = optionalEnv("PLATFORM_HOST") ?? "";
  const publicIp = optionalEnv("PUBLIC_IP") ?? "";
  const acmeEmail = optionalEnv("ACME_EMAIL") ?? "";
  const secureCookie = boolEnv("COOKIE_SECURE", false);

  add(
    "platform-host",
    "Public control-plane hostname",
    platformHost ? "pass" : "blocker",
    platformHost ? platformHost : "Set PLATFORM_HOST to the HTTPS dashboard hostname."
  );
  add(
    "secure-cookie",
    "Secure administrator cookie",
    platformHost && secureCookie ? "pass" : platformHost ? "blocker" : "warning",
    platformHost && secureCookie
      ? "COOKIE_SECURE is enabled."
      : platformHost
        ? "COOKIE_SECURE must be true on a public HTTPS control plane."
        : "Secure cookies will be required when a public hostname is configured."
  );
  add(
    "public-ip",
    "Public application IP",
    publicIp ? "pass" : "warning",
    publicIp ? publicIp : "Set PUBLIC_IP to enable application A-record verification."
  );
  add(
    "acme",
    "ACME / certificate email",
    acmeEmail && acmeEmail !== "admin@example.com" ? "pass" : "blocker",
    acmeEmail && acmeEmail !== "admin@example.com"
      ? acmeEmail
      : "Set a real ACME_EMAIL for certificate issuance and renewal notices."
  );

  if (platformHost && publicIp) {
    try {
      const addresses = await dns.resolve4(platformHost);
      add(
        "control-dns",
        "Control-plane DNS",
        addresses.includes(publicIp) ? "pass" : "blocker",
        addresses.includes(publicIp)
          ? `${platformHost} resolves to ${publicIp}.`
          : `${platformHost} resolves to ${addresses.join(", ") || "no IPv4 address"}, expected ${publicIp}.`
      );
    } catch (error) {
      add(
        "control-dns",
        "Control-plane DNS",
        "blocker",
        `Unable to resolve ${platformHost}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  } else {
    add("control-dns","Control-plane DNS","warning","Configure PLATFORM_HOST and PUBLIC_IP before DNS can be verified.");
  }

  const serverCounts = await one<{online:string;draining:string}>(`
    SELECT
      count(*) FILTER (WHERE last_seen_at > now() - interval '45 seconds')::text AS online,
      count(*) FILTER (WHERE draining=true AND last_seen_at > now() - interval '45 seconds')::text AS draining
    FROM servers
  `);
  const onlineServers = Number(serverCounts?.online ?? 0);
  const drainingServers = Number(serverCounts?.draining ?? 0);
  add(
    "runtime",
    "Runtime agent",
    onlineServers > 0 ? "pass" : "blocker",
    onlineServers > 0
      ? `${onlineServers} runtime server(s) online${drainingServers ? `; ${drainingServers} draining` : ""}.`
      : "No runtime agent has checked in within 45 seconds."
  );

  try {
    const updater = await platformUpdaterRequest("/info");
    add(
      "updater",
      "Independent platform updater",
      "pass",
      updater.updateAvailable
        ? `Updater reachable; release ${String(updater.targetSha ?? "").slice(0,12)} is available.`
        : "Updater reachable and release channel is accessible."
    );
  } catch (error) {
    add(
      "updater",
      "Independent platform updater",
      "blocker",
      `Updater unavailable: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  add(
    "automatic-backups",
    "Automatic application backups",
    boolEnv("AUTO_BACKUPS", true) ? "pass" : "warning",
    boolEnv("AUTO_BACKUPS", true) ? "AUTO_BACKUPS is enabled." : "AUTO_BACKUPS is disabled."
  );
  add(
    "predeploy-backups",
    "Recovery point before migrations",
    boolEnv("AUTO_PREDEPLOY_BACKUPS", true) ? "pass" : "blocker",
    boolEnv("AUTO_PREDEPLOY_BACKUPS", true)
      ? "Writable volumes and attached managed databases are backed up before migrations."
      : "AUTO_PREDEPLOY_BACKUPS is disabled; migrations can run without an automatic recovery point."
  );

  const latestPlatformBackup = await one<{completed_at:string|null;created_at:string|null;status:string}>(`
    SELECT completed_at,created_at,status
    FROM backups
    WHERE kind='platform'
    ORDER BY created_at DESC
    LIMIT 1
  `);
  if (!latestPlatformBackup) {
    add("platform-backup","Recent control-plane backup","warning","No platform backup record is present yet.");
  } else {
    const backupTime = new Date(latestPlatformBackup.completed_at ?? latestPlatformBackup.created_at ?? 0).getTime();
    const ageHours = backupTime ? (Date.now()-backupTime)/(60*60*1000) : Number.POSITIVE_INFINITY;
    add(
      "platform-backup",
      "Recent control-plane backup",
      latestPlatformBackup.status === "completed" && ageHours <= 48 ? "pass" : "warning",
      latestPlatformBackup.status === "completed"
        ? `Latest recorded platform backup is approximately ${Math.max(0,Math.round(ageHours))} hour(s) old.`
        : `Latest platform backup status: ${latestPlatformBackup.status}.`
    );
  }

  const resticConfigured = Boolean(optionalEnv("RESTIC_REPOSITORY") && optionalEnv("RESTIC_PASSWORD"));
  add(
    "offsite-backup",
    "Offsite disaster recovery",
    resticConfigured ? "pass" : "warning",
    resticConfigured
      ? "Restic repository and password are configured."
      : "Configure RESTIC_REPOSITORY and RESTIC_PASSWORD on a different failure domain."
  );

  const criticalAlerts = await one<{count:string}>(
    "SELECT count(*)::text count FROM alerts WHERE severity='critical' AND resolved_at IS NULL"
  );
  const criticalCount = Number(criticalAlerts?.count ?? 0);
  add(
    "critical-alerts",
    "Open critical alerts",
    criticalCount === 0 ? "pass" : "blocker",
    criticalCount === 0 ? "No unresolved critical alerts." : `${criticalCount} unresolved critical alert(s) require attention.`
  );

  const productionMode = (optionalEnv("NODE_ENV") ?? "production") === "production";
  add(
    "production-mode",
    "Production runtime mode",
    productionMode ? "pass" : "warning",
    productionMode ? "NODE_ENV=production." : `NODE_ENV=${optionalEnv("NODE_ENV") ?? "unset"}.`
  );

  const blockers = checks.filter((check)=>check.status==="blocker").length;
  const warnings = checks.filter((check)=>check.status==="warning").length;
  res.json({
    ready:blockers===0,
    blockers,
    warnings,
    passed:checks.filter((check)=>check.status==="pass").length,
    checks
  });
});

app.get("/api/platform/update/info", auth, async (_req, res) => {
  try {
    res.json(await platformUpdaterRequest("/info"));
  } catch (error) {
    const status = Number((error as any)?.status ?? 503);
    res.status(status).json({ error:error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/platform/update/status", auth, async (_req, res) => {
  try {
    res.json(await platformUpdaterRequest("/status"));
  } catch (error) {
    const status = Number((error as any)?.status ?? 503);
    res.status(status).json({ error:error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/platform/update", auth, async (req: AuthedRequest, res) => {
  try {
    const result = await platformUpdaterRequest("/update", { method:"POST", body:"{}" });
    await audit(req.userId ?? "unknown","platform.update.requested","platform",String(result.jobId ?? "update"),{
      ref:result.ref,
      currentSha:result.currentSha,
      targetSha:result.targetSha
    });
    res.status(202).json(result);
  } catch (error) {
    const status = Number((error as any)?.status ?? 503);
    res.status(status).json({ error:error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/platform/self-test", auth, async (req: AuthedRequest, res) => {
  const server = await one<any>(`
    SELECT id,name FROM servers
    WHERE draining=false AND last_seen_at > now() - interval '45 seconds'
    ORDER BY load1 ASC NULLS LAST LIMIT 1
  `);
  if (!server) return res.status(409).json({ error: "no online runtime server available" });
  const commandId = await enqueueAgentCommand(server.id,"SELF_TEST",{});
  await audit(req.userId ?? "unknown", "platform.self_test", "server", server.id);
  res.status(202).json({ commandId, server });
});

app.post("/api/services/:id/stop", auth, async (req: AuthedRequest, res) => {
  const serviceId = String(req.params.id);
  const commandId = await sendServiceCommand(serviceId, "STOP");
  if (!commandId) return res.status(409).json({ error: "service has never been assigned to a runtime server" });
  await audit(req.userId ?? "unknown", "service.stop", "service", serviceId);
  res.status(202).json({ commandId });
});

app.post("/api/services/:id/restart", auth, async (req: AuthedRequest, res) => {
  const serviceId = String(req.params.id);
  const commandId = await sendServiceCommand(serviceId, "RESTART");
  if (!commandId) return res.status(409).json({ error: "service has never been assigned to a runtime server" });
  await audit(req.userId ?? "unknown", "service.restart", "service", serviceId);
  res.status(202).json({ commandId });
});

/* Agent protocol */
app.post("/api/internal/agent/heartbeat", agentAuth, async (req, res) => {
  const parsed = z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    agentVersion: z.string().optional(),
    cpuCount: z.number().int().positive(),
    memoryTotalMb: z.number().nonnegative(),
    memoryFreeMb: z.number().nonnegative(),
    diskTotalMb: z.number().nonnegative(),
    diskFreeMb: z.number().nonnegative(),
    load1: z.number(),
    containerCount: z.number().int().nonnegative(),
    services: z.array(z.object({
      serviceId: z.string().min(1),
      deploymentId: z.string().nullable(),
      containerName: z.string(),
      running: z.boolean(),
      healthy: z.boolean(),
      statusCode: z.number().int().nullable(),
      latencyMs: z.number().int().nonnegative().nullable(),
      message: z.string().nullable()
    })).max(500).default([]),
    databases: z.array(z.object({
      databaseId: z.string().min(1),
      dockerName: z.string(),
      kind: z.enum(["postgres","redis"]),
      running: z.boolean(),
      healthy: z.boolean(),
      message: z.string().nullable()
    })).max(500).default([])
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const d = parsed.data;
  await pool.query(
    `INSERT INTO servers(id,name,status,agent_version,cpu_count,memory_total_mb,memory_free_mb,disk_total_mb,disk_free_mb,load1,container_count,last_seen_at)
     VALUES($1,$2,'online',$3,$4,$5,$6,$7,$8,$9,$10,now())
     ON CONFLICT(id) DO UPDATE SET name=excluded.name,status='online',agent_version=excluded.agent_version,
       cpu_count=excluded.cpu_count,memory_total_mb=excluded.memory_total_mb,memory_free_mb=excluded.memory_free_mb,
       disk_total_mb=excluded.disk_total_mb,disk_free_mb=excluded.disk_free_mb,load1=excluded.load1,
       container_count=excluded.container_count,last_seen_at=now()`,
    [d.id,d.name,d.agentVersion ?? null,d.cpuCount,d.memoryTotalMb,d.memoryFreeMb,d.diskTotalMb,d.diskFreeMb,d.load1,d.containerCount]
  );

  await resolveAlert(`server-offline:${d.id}`);

  const diskPctFree = d.diskTotalMb > 0 ? (d.diskFreeMb / d.diskTotalMb) * 100 : 100;
  if (diskPctFree < 10) {
    await openAlert({
      severity: diskPctFree < 5 ? "critical" : "warning",
      type: "disk",
      fingerprint: `server-disk:${d.id}`,
      title: `Low disk space on ${d.name}`,
      message: `${diskPctFree.toFixed(1)}% disk space remains (${d.diskFreeMb} MB free).`,
      targetType: "server",
      targetId: d.id
    });
  } else {
    await resolveAlert(`server-disk:${d.id}`);
  }

  for (const service of d.services) {
    const health = await one<{consecutive_failures:number}>(`
      INSERT INTO service_health(service_id,deployment_id,healthy,status_code,latency_ms,message,consecutive_failures,checked_at)
      VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $3 THEN 0 ELSE 1 END,now())
      ON CONFLICT(service_id) DO UPDATE SET
        deployment_id=excluded.deployment_id,
        healthy=excluded.healthy,
        status_code=excluded.status_code,
        latency_ms=excluded.latency_ms,
        message=excluded.message,
        consecutive_failures=CASE WHEN excluded.healthy THEN 0 ELSE service_health.consecutive_failures + 1 END,
        checked_at=now()
      RETURNING consecutive_failures
    `, [service.serviceId,service.deploymentId,service.healthy,service.statusCode,service.latencyMs,service.message]);

    const fingerprint = `service-unhealthy:${service.serviceId}`;
    if (service.healthy) {
      await resolveAlert(fingerprint);
      continue;
    }

    if ((health?.consecutive_failures ?? 0) >= 3) {
      const alert = await openAlert({
        severity: "critical",
        type: "service_health",
        fingerprint,
        title: `Service unhealthy: ${service.serviceId}`,
        message: service.message ?? "The runtime health probe failed three consecutive times.",
        targetType: "service",
        targetId: service.serviceId
      });

      if (alert && boolEnv("AUTO_ROLLBACK", false) && service.deploymentId) {
        await pool.query(
          "UPDATE deployments SET status='UNHEALTHY',failure_reason=$2 WHERE id=$1 AND status='RUNNING'",
          [service.deploymentId, service.message ?? "Continuous health monitoring failed"]
        );
        const activeJob = await one<any>(`
          SELECT id FROM deployments
          WHERE service_id=$1 AND status IN ('QUEUED','CLONING','BUILDING','PUSHING_IMAGE','PROVISIONING','STARTING','HEALTH_CHECKING','MIGRATING','ACTIVATING')
          LIMIT 1
        `, [service.serviceId]);
        if (!activeJob) {
          const previous = await one<any>(`
            SELECT * FROM deployments
            WHERE service_id=$1 AND id<>$2 AND image_ref IS NOT NULL AND status='SUPERSEDED'
            ORDER BY created_at DESC LIMIT 1
          `, [service.serviceId, service.deploymentId]);
          if (previous) {
            const rollbackId = await createDeployment(
              service.serviceId,
              "auto-rollback",
              previous.image_ref,
              previous.id,
              previous.runtime_port,
              previous.detected_build_type
            );
            await audit("system", "deployment.auto_rollback", "deployment", rollbackId, {
              unhealthyDeployment: service.deploymentId,
              previousDeployment: previous.id
            });
          }
        }
      }
    }
  }

  for (const database of d.databases) {
    const state = await one<{consecutive_failures:number}>(`
      UPDATE database_resources SET
        status=CASE WHEN $2 THEN 'running' ELSE 'unhealthy' END,
        health_message=$3,
        consecutive_failures=CASE WHEN $2 THEN 0 ELSE consecutive_failures + 1 END,
        last_health_at=now(),
        updated_at=now()
      WHERE id=$1
      RETURNING consecutive_failures
    `, [database.databaseId,database.healthy,database.message]);
    if(!state) continue;
    const fingerprint=`database-unhealthy:${database.databaseId}`;
    if(database.healthy){
      await resolveAlert(fingerprint);
    }else if(state.consecutive_failures >= 3){
      await openAlert({
        severity:"critical",
        type:"database_health",
        fingerprint,
        title:`Managed database unhealthy: ${database.databaseId}`,
        message:database.message ?? `${database.kind} health probe failed repeatedly.`,
        targetType:"database",
        targetId:database.databaseId
      });
    }
  }
  res.json({ ok: true });
});

app.post("/api/internal/agent/commands/claim", agentAuth, async (req, res) => {
  const serverId = String(req.body?.serverId ?? "");
  if (!serverId) return res.status(400).json({ error: "serverId required" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `SELECT * FROM agent_commands
       WHERE server_id=$1 AND status='queued'
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED LIMIT 1`,
      [serverId]
    );
    if (!result.rowCount) {
      await client.query("COMMIT");
      return res.status(204).end();
    }
    const command = result.rows[0];
    await client.query("UPDATE agent_commands SET status='running', claimed_at=now() WHERE id=$1", [command.id]);
    await client.query("COMMIT");
    if (command.payload_enc) {
      command.payload = JSON.parse(decryptSecret(command.payload_enc));
      delete command.payload_enc;
    }
    return res.json(command);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

app.post("/api/internal/agent/commands/:id/complete", agentAuth, async (req, res) => {
  const commandId = String(req.params.id);
  const status = req.body?.ok ? "completed" : "failed";
  const result = req.body?.result ?? {};

  const command = await one<any>(
    "SELECT deployment_id,action,payload,payload_enc FROM agent_commands WHERE id=$1",
    [commandId]
  );
  if (!command) return res.status(404).json({ error: "command not found" });

  const commandPayload = command.payload_enc ? JSON.parse(decryptSecret(command.payload_enc)) : command.payload;
  const serviceId = commandPayload?.serviceId ? String(commandPayload.serviceId) : undefined;

  const redactedResult = await redactResultValue(serviceId, result) as Record<string, unknown>;
  let publicResult: Record<string, unknown> = redactedResult;
  if (command.action === "FETCH_LOGS") {
    publicResult = {
      containerName: redactedResult?.containerName ?? null,
      logsStored: true
    };
  } else if (command.action === "RUN_CRON") {
    publicResult = {
      exitCode: redactedResult?.exitCode ?? null,
      timedOut: Boolean(redactedResult?.timedOut)
    };
  }

  await pool.query(
    "UPDATE agent_commands SET status=$1,result=$2,result_enc=$3,completed_at=now() WHERE id=$4",
    [status, JSON.stringify(publicResult), encryptSecret(JSON.stringify(result)), commandId]
  );

  const backupId = commandPayload?.backupId;
  if (backupId && ["BACKUP_VOLUME","BACKUP_DATABASE"].includes(command.action)) {
    await pool.query(
      "UPDATE backups SET status=$2, location=$3, size_bytes=$4, completed_at=now() WHERE id=$1",
      [backupId, status === "completed" ? "completed" : "failed", result.location ?? null, result.sizeBytes ?? null]
    );
    if(status==="failed"){
      await openAlert({
        severity:"critical",type:"backup",fingerprint:`backup:${backupId}`,
        title:"Backup failed",message:String((publicResult as any).error ?? "The runtime agent could not create the backup."),
        targetType:"backup",targetId:backupId
      });
    }else{
      await resolveAlert(`backup:${backupId}`);
    }
  }

  if (backupId && ["TEST_VOLUME_BACKUP","TEST_DATABASE_BACKUP"].includes(command.action) && status === "completed") {
    await pool.query("UPDATE backups SET restore_tested_at=now() WHERE id=$1", [backupId]);
  }

  if (command.action === "PROVISION_DATABASE" && commandPayload?.databaseId) {
    await pool.query(
      "UPDATE database_resources SET status=$2,updated_at=now() WHERE id=$1",
      [commandPayload.databaseId,status === "completed" ? "running" : "failed"]
    );
  }

  if (command.action === "REMOVE_DATABASE" && commandPayload?.databaseId) {
    const database = await one<any>(
      "SELECT * FROM database_resources WHERE id=$1",
      [commandPayload.databaseId]
    );

    if (status === "completed") {
      if (database) {
        await removeManagedConnectionVariable(database);
        if (database.service_id) {
          await pool.query(
            "UPDATE deployments SET status='STOPPED' WHERE service_id=$1 AND status IN ('RUNNING','UNHEALTHY')",
            [database.service_id]
          );
          await pool.query(
            "UPDATE service_health SET healthy=false,message='Stopped for managed database removal',checked_at=now() WHERE service_id=$1",
            [database.service_id]
          );
          await resolveAlert(`service-unhealthy:${database.service_id}`);
        }

        if (commandPayload.deleteData) {
          await pool.query("DELETE FROM database_resources WHERE id=$1", [commandPayload.databaseId]);
        } else {
          await pool.query(
            `UPDATE database_resources
             SET status='detached',health_message='Container removed; data volume and encrypted credentials retained',
                 consecutive_failures=0,last_health_at=now(),updated_at=now()
             WHERE id=$1`,
            [commandPayload.databaseId]
          );
        }
      }
      await resolveAlert(`database-delete:${commandPayload.databaseId}`);
      await audit("system",commandPayload.deleteData ? "database.delete.completed" : "database.detach.completed","database",commandPayload.databaseId,{
        deleteData:Boolean(commandPayload.deleteData)
      });
    } else {
      await pool.query(
        "UPDATE database_resources SET status='delete_failed',health_message=$2,updated_at=now() WHERE id=$1",
        [commandPayload.databaseId,String((publicResult as any).error ?? "Runtime database cleanup failed")]
      );
      await openAlert({
        severity:"critical",
        type:"database_delete",
        fingerprint:`database-delete:${commandPayload.databaseId}`,
        title:"Managed database removal failed",
        message:String((publicResult as any).error ?? "The runtime could not remove the managed database."),
        targetType:"database",
        targetId:commandPayload.databaseId
      });
    }
  }

  if (command.action === "REMOVE_VOLUME" && commandPayload?.volumeId) {
    const volume = await one<any>(
      "SELECT * FROM volumes WHERE id=$1",
      [commandPayload.volumeId]
    );

    if (status === "completed") {
      if (volume?.service_id) {
        await pool.query(
          "UPDATE deployments SET status='STOPPED' WHERE service_id=$1 AND status IN ('RUNNING','UNHEALTHY')",
          [volume.service_id]
        );
        await pool.query(
          "UPDATE service_health SET healthy=false,message='Stopped for persistent volume detach/removal',checked_at=now() WHERE service_id=$1",
          [volume.service_id]
        );
        await resolveAlert(`service-unhealthy:${volume.service_id}`);
      }

      if (commandPayload.deleteData) {
        await pool.query("DELETE FROM volumes WHERE id=$1", [commandPayload.volumeId]);
      } else {
        await pool.query(
          "UPDATE volumes SET status='detached',detached_at=now() WHERE id=$1",
          [commandPayload.volumeId]
        );
      }

      await resolveAlert(`volume-delete:${commandPayload.volumeId}`);
      await audit(
        "system",
        commandPayload.deleteData ? "volume.delete.completed" : "volume.detach.completed",
        "volume",
        commandPayload.volumeId,
        { deleteData:Boolean(commandPayload.deleteData) }
      );
    } else {
      await pool.query(
        "UPDATE volumes SET status='delete_failed' WHERE id=$1",
        [commandPayload.volumeId]
      );
      await openAlert({
        severity:"critical",
        type:"volume_delete",
        fingerprint:`volume-delete:${commandPayload.volumeId}`,
        title:"Persistent volume cleanup failed",
        message:String((publicResult as any).error ?? "The runtime could not detach/remove the persistent volume."),
        targetType:"volume",
        targetId:commandPayload.volumeId
      });
    }
  }

  if (command.action === "STOP" && commandPayload?.serviceId && status === "completed") {
    await pool.query(
      "UPDATE deployments SET status='STOPPED' WHERE service_id=$1 AND status IN ('RUNNING','UNHEALTHY')",
      [commandPayload.serviceId]
    );
    await pool.query(
      "UPDATE service_health SET healthy=false,message='Stopped by operator',checked_at=now() WHERE service_id=$1",
      [commandPayload.serviceId]
    );
    await resolveAlert(`service-unhealthy:${commandPayload.serviceId}`);
  }

  if (command.action === "FETCH_LOGS" && command.deployment_id && status === "completed") {
    const text = await redactServiceSecrets(serviceId, String(result.logs ?? "No runtime log output.").slice(-1_000_000));
    await pool.query(
      "INSERT INTO deployment_logs(deployment_id,level,message) VALUES($1,'runtime',$2)",
      [command.deployment_id, `[runtime ${result.containerName ?? "container"}]\n${text}`]
    );
  }

  if (command.action === "RUN_CRON" && commandPayload?.runId) {
    const exitCode = typeof result.exitCode === "number" ? result.exitCode : (status === "completed" ? 0 : 1);
    const runStatus = status === "completed" && exitCode === 0 ? "completed" : "failed";
    const logs = await redactServiceSecrets(
      serviceId,
      String(result.logs ?? result.error ?? "").slice(-1_000_000)
    );
    await pool.query(
      `UPDATE cron_runs SET status=$2,exit_code=$3,logs=$4,
       started_at=COALESCE(started_at,now()),completed_at=now()
       WHERE id=$1`,
      [commandPayload.runId,runStatus,exitCode,logs]
    );
    const fingerprint=`cron:${commandPayload.serviceId}`;
    if(runStatus==="completed"){
      await resolveAlert(fingerprint);
      await resolveAlert(`cron-scheduler:${commandPayload.serviceId}`);
    }else{
      await openAlert({
        severity:"critical",
        type:"cron",
        fingerprint,
        title:`Cron run failed: ${commandPayload.serviceId}`,
        message:result.timedOut ? "Cron run exceeded its timeout." : `Cron command exited with code ${exitCode}.`,
        targetType:"service",
        targetId:commandPayload.serviceId
      });
    }
  }

  res.json({ ok: true });
});

app.use(express.static(path.join(process.cwd(), "public"), { maxAge: "1h" }));
app.use((_req, res) => res.sendFile(path.join(process.cwd(), "public", "index.html")));

async function start() {
  if (boolEnv("AUTO_MIGRATE", true)) await ensureSchema();
  const bootstrapPassword = optionalEnv("ADMIN_BOOTSTRAP_PASSWORD");
  if (bootstrapPassword) {
    const count = await one<{count:string}>("SELECT count(*)::text count FROM users");
    if (Number(count?.count ?? 0) === 0) {
      const hash = await bcrypt.hash(bootstrapPassword, 12);
      await pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,'admin@localhost',$2)", [id("usr"), hash]);
      console.log("Created bootstrap admin user admin@localhost");
    }
  }
  app.listen(port, "0.0.0.0", () => console.log(`My Railway control plane listening on :${port}`));

  if (boolEnv("AUTO_BACKUPS", true)) {
    setTimeout(() => void runAutomaticBackups().catch((error)=>console.error("Automatic backup sweep failed:",error)), 60_000).unref();
    setInterval(() => void runAutomaticBackups().catch((error)=>console.error("Automatic backup sweep failed:",error)), 60*60_000).unref();
  }

  setTimeout(() => void runMetadataRetention().catch((error)=>console.error("Metadata retention sweep failed:",error)), 90_000).unref();
  setInterval(() => void runMetadataRetention().catch((error)=>console.error("Metadata retention sweep failed:",error)), 6*60*60_000).unref();

  setTimeout(() => void runCronSweep().catch((error)=>console.error("Cron sweep failed:",error)), 5_000).unref();
  setInterval(() => void runCronSweep().catch((error)=>console.error("Cron sweep failed:",error)), 30_000).unref();

  setInterval(async () => {
    try {
      const offline = await query<{id:string;name:string}>(`
        SELECT id,name FROM servers
        WHERE last_seen_at IS NOT NULL AND last_seen_at < now() - interval '45 seconds'
      `);
      for (const server of offline) {
        await openAlert({
          severity: "critical",
          type: "server_offline",
          fingerprint: `server-offline:${server.id}`,
          title: `Runtime offline: ${server.name}`,
          message: "No agent heartbeat has been received for more than 45 seconds.",
          targetType: "server",
          targetId: server.id
        });
      }
    } catch (error) {
      console.error("Server monitor failed:", error);
    }
  }, 30_000).unref();
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
