import express, { type NextFunction, type Request, type Response } from "express";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import path from "node:path";
import { authenticator } from "otplib";
import { z } from "zod";
import { pool, one, query, ensureSchema } from "../shared/db.js";
import { encryptSecret, decryptSecret } from "../shared/crypto.js";
import { env, optionalEnv, boolEnv } from "../shared/env.js";
import { enqueueDeployment } from "../shared/queue.js";
import { id, slug } from "../shared/util.js";

const app = express();
const port = Number(process.env.PORT ?? 8080);
const sessionSecret = env("SESSION_SECRET");
const agentToken = env("AGENT_TOKEN");
const cookieSecure = boolEnv("COOKIE_SECURE", false);

type AuthedRequest = Request & { userId?: string };

function safeUser(user: Record<string, unknown>) {
  const { password_hash: _p, totp_secret_enc: _t, ...rest } = user;
  return rest;
}

function signSession(userId: string) {
  return jwt.sign({ sub: userId }, sessionSecret, { expiresIn: "12h", issuer: "my-railway" });
}

function auth(req: AuthedRequest, res: Response, next: NextFunction) {
  const token = req.cookies?.mr_session;
  if (!token) return res.status(401).json({ error: "authentication required" });
  try {
    const payload = jwt.verify(token, sessionSecret, { issuer: "my-railway" }) as jwt.JwtPayload;
    req.userId = String(payload.sub);
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

async function createDeployment(
  serviceId: string,
  source: string,
  imageRef?: string,
  rollbackOf?: string,
  runtimePort?: number | null,
  detectedBuildType?: string | null
) {
  const deploymentId = id("dep");
  await pool.query(
    "INSERT INTO deployments(id,service_id,source,image_ref,rollback_of,runtime_port,detected_build_type,status) VALUES($1,$2,$3,$4,$5,$6,$7,'QUEUED')",
    [deploymentId, serviceId, source, imageRef ?? null, rollbackOf ?? null, runtimePort ?? null, detectedBuildType ?? null]
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
  const parsed = z.object({
    email: z.string().email().default("admin@localhost"),
    password: z.string().min(12)
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const userId = id("usr");
  const hash = await bcrypt.hash(parsed.data.password, 12);
  await pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)", [userId, parsed.data.email.toLowerCase(), hash]);
  await audit(parsed.data.email, "platform.bootstrap", "user", userId);
  res.status(201).json({ ok: true });
});

app.post("/api/auth/login", async (req, res) => {
  const parsed = z.object({
    email: z.string().email(),
    password: z.string(),
    totp: z.string().optional()
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid credentials" });
  const user = await one<any>("SELECT * FROM users WHERE email=$1", [parsed.data.email.toLowerCase()]);
  if (!user || !(await bcrypt.compare(parsed.data.password, user.password_hash))) {
    return res.status(401).json({ error: "invalid credentials" });
  }
  if (user.totp_enabled) {
    if (!parsed.data.totp || !user.totp_secret_enc) return res.status(401).json({ error: "totp required", totpRequired: true });
    const secret = decryptSecret(user.totp_secret_enc);
    if (!authenticator.check(parsed.data.totp, secret)) return res.status(401).json({ error: "invalid totp", totpRequired: true });
  }
  await pool.query("UPDATE users SET last_login_at=now() WHERE id=$1", [user.id]);
  res.cookie("mr_session", signSession(user.id), {
    httpOnly: true,
    sameSite: "strict",
    secure: cookieSecure,
    maxAge: 12 * 60 * 60 * 1000,
    path: "/"
  });
  await audit(user.email, "auth.login", "user", user.id);
  res.json({ user: safeUser(user) });
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
  await pool.query("UPDATE users SET totp_enabled=true WHERE id=$1", [user.id]);
  await audit(user.email, "auth.totp.enabled", "user", user.id);
  res.json({ ok: true });
});

app.get("/api/overview", auth, async (_req, res) => {
  const [projects, running, failed, servers, queued, backups] = await Promise.all([
    one<{count:string}>("SELECT count(*)::text count FROM projects"),
    one<{count:string}>("SELECT count(*)::text count FROM deployments WHERE status='RUNNING'"),
    one<{count:string}>("SELECT count(*)::text count FROM deployments WHERE status LIKE '%FAILED'"),
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
    kind: z.enum(["web", "worker"]).default("web"),
    buildType: z.enum(["auto", "docker", "node", "python", "static"]).default("auto"),
    internalPort: z.number().int().min(1).max(65535).default(3000),
    healthPath: z.string().startsWith("/").default("/")
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const projectId = id("prj");
  const serviceId = id("svc");
  const projectSlug = `${slug(parsed.data.name)}-${crypto.randomBytes(2).toString("hex")}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO projects(id,name,slug) VALUES($1,$2,$3)", [projectId, parsed.data.name, projectSlug]);
    await client.query(
      `INSERT INTO services(id,project_id,name,kind,repo_full_name,branch,build_type,internal_port,health_path)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [serviceId, projectId, parsed.data.name, parsed.data.kind, parsed.data.repoFullName, parsed.data.branch, parsed.data.buildType, parsed.data.internalPort, parsed.data.healthPath]
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

app.get("/api/projects/:id", auth, async (req, res) => {
  const project = await one<any>("SELECT * FROM projects WHERE id=$1", [String(req.params.id)]);
  if (!project) return res.status(404).json({ error: "not found" });
  const services = await query<any>("SELECT * FROM services WHERE project_id=$1 ORDER BY created_at", [project.id]);
  for (const service of services) {
    service.domains = await query("SELECT * FROM domains WHERE service_id=$1 ORDER BY hostname", [service.id]);
    service.variables = await query("SELECT id,key,is_secret,created_at,updated_at FROM variables WHERE service_id=$1 ORDER BY key", [service.id]);
    service.volumes = await query("SELECT * FROM volumes WHERE service_id=$1 ORDER BY created_at", [service.id]);
    service.deployments = await query("SELECT * FROM deployments WHERE service_id=$1 ORDER BY created_at DESC LIMIT 30", [service.id]);
  }
  res.json({ ...project, services });
});

app.delete("/api/projects/:id", auth, async (req: AuthedRequest, res) => {
  const project = await one<any>("DELETE FROM projects WHERE id=$1 RETURNING *", [String(req.params.id)]);
  if (!project) return res.status(404).json({ error: "not found" });
  await audit(req.userId ?? "unknown", "project.delete", "project", project.id, { name: project.name });
  res.json({ ok: true });
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
    autoDeploy: z.boolean().optional()
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const mapping: Record<string,string> = {
    branch:"branch", rootDirectory:"root_directory", buildType:"build_type", buildCommand:"build_command",
    startCommand:"start_command", predeployCommand:"predeploy_command", internalPort:"internal_port",
    healthPath:"health_path", cpuLimit:"cpu_limit", memoryMb:"memory_mb", autoDeploy:"auto_deploy"
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
  const result = await pool.query(`UPDATE services SET ${sets.join(",")}, updated_at=now() WHERE id=$${values.length} RETURNING *`, values);
  if (!result.rowCount) return res.status(404).json({ error: "not found" });
  await audit(req.userId ?? "unknown", "service.update", "service", String(req.params.id), parsed.data);
  res.json(result.rows[0]);
});

app.post("/api/services/:id/deploy", auth, async (req: AuthedRequest, res) => {
  const service = await one<any>("SELECT * FROM services WHERE id=$1", [String(req.params.id)]);
  if (!service) return res.status(404).json({ error: "service not found" });
  const deploymentId = await createDeployment(service.id, "manual");
  await audit(req.userId ?? "unknown", "deployment.create", "deployment", deploymentId, { serviceId: service.id });
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

app.get("/api/servers", auth, async (_req, res) => {
  const rows = await query("SELECT *, (last_seen_at > now() - interval '45 seconds') AS online FROM servers ORDER BY name");
  res.json(rows);
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
  const volume = await one<any>("DELETE FROM volumes WHERE id=$1 RETURNING *", [String(req.params.id)]);
  if (!volume) return res.status(404).json({ error: "volume not found" });
  await audit(req.userId ?? "unknown", "volume.detach", "volume", volume.id, { dockerVolumeName: volume.docker_volume_name });
  res.json({ ok: true, note: "Volume metadata detached; Docker volume data was intentionally left intact." });
});

app.post("/api/volumes/:id/backup", auth, async (req: AuthedRequest, res) => {
  const volume = await one<any>(`
    SELECT v.*, s.id service_id
    FROM volumes v JOIN services s ON s.id=v.service_id
    WHERE v.id=$1
  `, [String(req.params.id)]);
  if (!volume) return res.status(404).json({ error: "volume not found" });
  const active = await one<any>(`
    SELECT server_id FROM deployments
    WHERE service_id=$1 AND server_id IS NOT NULL AND status='RUNNING'
    ORDER BY completed_at DESC NULLS LAST, created_at DESC LIMIT 1
  `, [volume.service_id]);
  if (!active?.server_id) return res.status(409).json({ error: "no active runtime server for this service" });
  const backupId = id("bak");
  const commandId = id("cmd");
  await pool.query(
    "INSERT INTO backups(id,service_id,volume_id,server_id,kind,status) VALUES($1,$2,$3,$4,'volume','queued')",
    [backupId, volume.service_id, volume.id, active.server_id]
  );
  await pool.query(
    "INSERT INTO agent_commands(id,server_id,action,payload) VALUES($1,$2,'BACKUP_VOLUME',$3)",
    [commandId, active.server_id, JSON.stringify({ volumeName: volume.docker_volume_name, backupName: backupId, backupId })]
  );
  await audit(req.userId ?? "unknown", "backup.create", "backup", backupId, { volumeId: volume.id });
  res.status(202).json({ backupId, commandId });
});

app.post("/api/backups/:id/test", auth, async (req: AuthedRequest, res) => {
  const backup = await one<any>("SELECT * FROM backups WHERE id=$1", [String(req.params.id)]);
  if (!backup || backup.status !== "completed" || !backup.location || !backup.server_id) {
    return res.status(409).json({ error: "completed backup with a runtime location is required" });
  }
  const commandId = id("cmd");
  await pool.query(
    "INSERT INTO agent_commands(id,server_id,action,payload) VALUES($1,$2,'TEST_VOLUME_BACKUP',$3)",
    [commandId, backup.server_id, JSON.stringify({ backupId: backup.id, fileName: path.basename(backup.location) })]
  );
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
  const commandId = id("cmd");
  await pool.query(
    "INSERT INTO agent_commands(id,server_id,action,payload) VALUES($1,$2,'RESTORE_VOLUME',$3)",
    [commandId, backup.server_id, JSON.stringify({
      backupId: backup.id,
      serviceId: backup.service_id,
      volumeName: backup.docker_volume_name,
      fileName: path.basename(backup.location)
    })]
  );
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
  const commandId = id("cmd");
  await pool.query(
    "INSERT INTO agent_commands(id,server_id,action,payload) VALUES($1,$2,$3,$4)",
    [commandId, active.server_id, action, JSON.stringify({ serviceId })]
  );
  return commandId;
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
  const commandId = id("cmd");
  await pool.query(
    "INSERT INTO agent_commands(id,server_id,deployment_id,action,payload) VALUES($1,$2,$3,'FETCH_LOGS',$4)",
    [commandId, active.server_id, active.id, JSON.stringify({ serviceId })]
  );
  await audit(req.userId ?? "unknown", "runtime.logs.refresh", "service", serviceId);
  res.status(202).json({ commandId, deploymentId: active.id });
});

app.post("/api/platform/self-test", auth, async (req: AuthedRequest, res) => {
  const server = await one<any>(`
    SELECT id,name FROM servers
    WHERE last_seen_at > now() - interval '45 seconds'
    ORDER BY load1 ASC NULLS LAST LIMIT 1
  `);
  if (!server) return res.status(409).json({ error: "no online runtime server available" });
  const commandId = id("cmd");
  await pool.query(
    "INSERT INTO agent_commands(id,server_id,action,payload) VALUES($1,$2,'SELF_TEST','{}'::jsonb)",
    [commandId, server.id]
  );
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
  const status = req.body?.ok ? "completed" : "failed";
  const result = req.body?.result ?? {};
  const updated = await pool.query(
    "UPDATE agent_commands SET status=$1,result=$2,completed_at=now() WHERE id=$3 RETURNING deployment_id,action,payload,payload_enc",
    [status, JSON.stringify(result), String(req.params.id)]
  );
  if (!updated.rowCount) return res.status(404).json({ error: "command not found" });
  const command = updated.rows[0];
  const commandPayload = command.payload_enc ? JSON.parse(decryptSecret(command.payload_enc)) : command.payload;
  const backupId = commandPayload?.backupId;
  if (backupId && command.action === "BACKUP_VOLUME") {
    await pool.query(
      "UPDATE backups SET status=$2, location=$3, size_bytes=$4, completed_at=now() WHERE id=$1",
      [backupId, status === "completed" ? "completed" : "failed", result.location ?? null, result.sizeBytes ?? null]
    );
  }
  if (backupId && command.action === "TEST_VOLUME_BACKUP" && status === "completed") {
    await pool.query("UPDATE backups SET restore_tested_at=now() WHERE id=$1", [backupId]);
  }
  if (command.action === "FETCH_LOGS" && command.deployment_id && status === "completed") {
    const text = String(result.logs ?? "No runtime log output.").slice(-1_000_000);
    await pool.query(
      "INSERT INTO deployment_logs(deployment_id,level,message) VALUES($1,'runtime',$2)",
      [command.deployment_id, `[runtime ${result.containerName ?? "container"}]\n${text}`]
    );
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
