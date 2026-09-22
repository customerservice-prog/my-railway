const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = { view: "overview" };

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  })[m]);
}

function fmt(value) {
  return value ? new Date(value).toLocaleString() : "—";
}

function statusClass(status) {
  const s = String(status ?? "");
  if (/RUNNING|completed|online|healthy/i.test(s)) return "good";
  if (/FAIL|offline|unhealthy|critical/i.test(s)) return "bad";
  if (/QUEUED|BUILD|START|PROVISION|HEALTH|MIGRAT|warning/i.test(s)) return "warn";
  return "";
}

function errorMessage(data, fallback) {
  if (!data) return fallback;
  if (typeof data.error === "string") return data.error;
  if (data.error) return JSON.stringify(data.error);
  return fallback;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) }
  });
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (response.status === 401) {
    const error = new Error("unauthorized");
    error.unauthorized = true;
    error.data = data;
    throw error;
  }
  if (!response.ok) throw new Error(errorMessage(data, `Request failed ${response.status}`));
  return data;
}

async function pollCommand(commandId, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const command = await api(`/api/commands/${encodeURIComponent(commandId)}`);
    if (command.status === "completed") return command;
    if (command.status === "failed") throw new Error(command.result?.error || `${command.action} failed`);
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  throw new Error("Operation timed out");
}

function showDialog(title, body) {
  const dialog = $("#project-detail-dialog");
  $("#project-detail").innerHTML = `
    <div class="detail-head">
      <div><div class="eyebrow">MY RAILWAY</div><h3>${esc(title)}</h3></div>
      <button class="icon-btn" id="close-detail">×</button>
    </div>
    <div class="detail-body">${body}</div>
  `;
  dialog.showModal();
  $("#close-detail").onclick = () => dialog.close();
  return dialog;
}

async function boot() {
  try {
    await api("/api/auth/me");
    $("#auth").classList.add("hidden");
    $("#app").classList.remove("hidden");
    await render();
  } catch {
    $("#app").classList.add("hidden");
    $("#auth").classList.remove("hidden");
  }
}

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#auth-error").textContent = "";
  try {
    await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: $("#login-email").value,
        password: $("#login-password").value,
        totp: $("#login-totp").value || undefined
      })
    });
    await boot();
  } catch (error) {
    if (error.data?.totpRequired) $("#totp-label").classList.remove("hidden");
    $("#auth-error").textContent = error.message;
  }
});

$("#bootstrap-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/auth/bootstrap", {
      method: "POST",
      body: JSON.stringify({
        email: $("#bootstrap-email").value,
        password: $("#bootstrap-password").value
      })
    });
    $("#login-email").value = $("#bootstrap-email").value;
    $("#login-password").value = $("#bootstrap-password").value;
    $("#auth-error").textContent = "Platform initialized. Sign in.";
  } catch (error) {
    $("#auth-error").textContent = error.message;
  }
});

$("#logout").onclick = async () => {
  await api("/api/auth/logout", { method: "POST" }).catch(() => {});
  location.reload();
};

$$(".nav").forEach((button) => {
  button.onclick = () => {
    state.view = button.dataset.view;
    $$(".nav").forEach((item) => item.classList.toggle("active", item === button));
    render();
  };
});

$("#refresh").onclick = () => render();
$("#new-project").onclick = () => $("#project-dialog").showModal();

$("#self-test").onclick = async () => {
  try {
    const queued = await api("/api/platform/self-test", { method: "POST" });
    showDialog("Platform self-test", '<div class="panel empty">Running infrastructure checks…</div>');
    const command = await pollCommand(queued.commandId, 10 * 60_000);
    const result = command.result || {};
    const rows = (result.checks || []).map((check) => `
      <div class="kv">
        <span>${esc(check.name)}</span>
        <span><span class="pill ${check.ok ? "good" : "bad"}">${check.ok ? "PASS" : "FAIL"}</span> ${esc(check.detail)}</span>
      </div>
    `).join("");
    showDialog(result.ok ? "Platform self-test passed" : "Platform self-test found problems", rows || "<div class='empty'>No checks returned.</div>");
  } catch (error) {
    showDialog("Platform self-test failed", `<div class="error">${esc(error.message)}</div>`);
  }
};

$("#project-form").addEventListener("submit", async (event) => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const body = Object.fromEntries(form.entries());
  body.internalPort = Number(body.internalPort);
  if (!body.domain) delete body.domain;
  try {
    const created = await api("/api/projects", { method: "POST", body: JSON.stringify(body) });
    $("#project-dialog").close();
    event.currentTarget.reset();
    await render();
    await openProject(created.id);
  } catch (error) {
    alert(error.message);
  }
});

async function render() {
  const titles = {
    overview: "Overview",
    projects: "Projects",
    deployments: "Deployments",
    servers: "Servers",
    databases: "Databases",
    backups: "Backups",
    alerts: "Alerts",
    security: "Security",
    audit: "Audit log"
  };
  $("#view-title").textContent = titles[state.view] || "My Railway";

  try {
    const health = await fetch("/healthz").then((r) => r.json());
    $("#platform-status").textContent = health.status === "ok" ? "Control plane healthy" : "Control plane degraded";
  } catch {
    $("#platform-status").textContent = "Control plane unreachable";
  }

  try {
    if (state.view === "overview") return renderOverview();
    if (state.view === "projects") return renderProjects();
    if (state.view === "deployments") return renderDeployments();
    if (state.view === "servers") return renderServers();
    if (state.view === "databases") return renderDatabases();
    if (state.view === "backups") return renderBackups();
    if (state.view === "alerts") return renderAlerts();
    if (state.view === "security") return renderSecurity();
    if (state.view === "audit") return renderAudit();
  } catch (error) {
    if (error.unauthorized) return boot();
    $("#content").innerHTML = `<div class="panel empty danger">${esc(error.message)}</div>`;
  }
}

function projectCard(project) {
  return `
    <article class="project-card" data-project="${esc(project.id)}">
      <div class="row between">
        <div class="project-name">${esc(project.name)}</div>
        <span class="pill ${statusClass(project.last_status)}">${esc(project.last_status || "never deployed")}</span>
      </div>
      <div class="project-meta">${esc(project.service_count)} service · last deploy ${fmt(project.last_deploy_at)}</div>
      <div class="row"><button class="open-project">Open project</button></div>
    </article>
  `;
}

function wireProjectCards(root = document) {
  $$(".open-project", root).forEach((button) => {
    button.onclick = (event) => openProject(event.currentTarget.closest("[data-project]").dataset.project);
  });
}

function deploymentTable(rows) {
  const body = rows.map((deployment) => `
    <tr>
      <td>${esc(deployment.project_name || "")}</td>
      <td>${esc(deployment.service_name || "")}</td>
      <td><span class="pill ${statusClass(deployment.status)}">${esc(deployment.status)}</span></td>
      <td class="mono">${esc((deployment.commit_sha || "").slice(0, 10) || "—")}</td>
      <td>${fmt(deployment.created_at)}</td>
      <td>
        <button data-logs="${esc(deployment.id)}">Logs</button>
        ${deployment.image_ref ? `<button data-rollback="${esc(deployment.id)}">Rollback here</button>` : ""}
      </td>
    </tr>
  `).join("");

  return `
    <div class="panel">
      <table class="table">
        <thead><tr><th>Project</th><th>Service</th><th>Status</th><th>Commit</th><th>Created</th><th></th></tr></thead>
        <tbody>${body || '<tr><td colspan="6" class="empty">No deployments yet.</td></tr>'}</tbody>
      </table>
    </div>
  `;
}

function wireDeployments(root = document) {
  $$("[data-logs]", root).forEach((button) => button.onclick = () => showLogs(button.dataset.logs));
  $$("[data-rollback]", root).forEach((button) => button.onclick = () => rollback(button.dataset.rollback));
}

async function renderOverview() {
  const [overview, projects, deployments, alerts] = await Promise.all([
    api("/api/overview"), api("/api/projects"), api("/api/deployments"), api("/api/alerts")
  ]);
  const openAlerts = alerts.filter((alert) => !alert.resolved_at);
  const metrics = [
    ["Projects", overview.projects],
    ["Running", overview.running],
    ["Deploying", overview.queued],
    ["Failed", overview.failed],
    ["Servers online", overview.onlineServers],
    ["Open alerts", openAlerts.length]
  ].map(([label, value]) => `
    <div class="metric"><div class="label">${label}</div><div class="value">${value}</div></div>
  `).join("");

  $("#content").innerHTML = `
    <div class="cards">${metrics}</div>
    ${openAlerts.length ? `
      <div class="section-head"><h3>Needs attention</h3></div>
      <div class="panel">
        ${openAlerts.slice(0, 5).map((alert) => `
          <div class="kv"><span><span class="pill ${statusClass(alert.severity)}">${esc(alert.severity)}</span></span><span><strong>${esc(alert.title)}</strong><br><span class="muted">${esc(alert.message)}</span></span></div>
        `).join("")}
      </div>
    ` : ""}
    <div class="section-head"><h3>Projects</h3><span class="muted">Your private application cloud</span></div>
    <div class="project-grid">${projects.slice(0, 6).map(projectCard).join("") || '<div class="panel empty">No projects yet. Create your first deployment.</div>'}</div>
    <div class="section-head"><h3>Recent deployments</h3></div>
    ${deploymentTable(deployments.slice(0, 8))}
  `;
  wireProjectCards();
  wireDeployments();
}

async function renderProjects() {
  const projects = await api("/api/projects");
  $("#content").innerHTML = `<div class="project-grid">${projects.map(projectCard).join("") || '<div class="panel empty">No projects yet.</div>'}</div>`;
  wireProjectCards();
}

async function renderDeployments() {
  const deployments = await api("/api/deployments");
  $("#content").innerHTML = deploymentTable(deployments);
  wireDeployments();
}

async function showLogs(id) {
  const logs = await api(`/api/deployments/${encodeURIComponent(id)}/logs`);
  showDialog(id, `<div class="log">${logs.map((line) => `[${new Date(line.ts).toLocaleTimeString()}] [${esc(line.level)}] ${esc(line.message)}`).join("\n") || "No logs yet."}</div>`);
}

async function rollback(id) {
  if (!confirm("Create a new deployment from this exact image and runtime metadata?")) return;
  await api(`/api/deployments/${encodeURIComponent(id)}/rollback`, { method: "POST" });
  await render();
}

async function renderServers() {
  const servers = await api("/api/servers");
  const body = servers.map((server) => `
    <tr>
      <td><strong>${esc(server.name)}</strong><div class="mono muted">${esc(server.id)}</div></td>
      <td><span class="pill ${server.online ? "good" : "bad"}">${server.online ? "online" : "offline"}</span></td>
      <td>${esc(server.cpu_count || "—")} cores · load ${Number(server.load1 || 0).toFixed(2)}</td>
      <td>${esc(server.memory_free_mb || 0)} / ${esc(server.memory_total_mb || 0)} MB</td>
      <td>${esc(server.disk_free_mb || 0)} / ${esc(server.disk_total_mb || 0)} MB</td>
      <td>${esc(server.container_count || 0)}</td>
      <td>${fmt(server.last_seen_at)}</td>
    </tr>
  `).join("");

  $("#content").innerHTML = `
    <div class="panel"><table class="table">
      <thead><tr><th>Server</th><th>Status</th><th>CPU</th><th>Memory free</th><th>Disk free</th><th>Containers</th><th>Last seen</th></tr></thead>
      <tbody>${body || '<tr><td colspan="7" class="empty">No agents connected.</td></tr>'}</tbody>
    </table></div>
  `;
}

async function renderDatabases() {
  const databases = await api("/api/databases");
  const body = databases.map((database) => `
    <tr>
      <td><strong>${esc(database.name)}</strong><div class="mono muted">${esc(database.id)}</div></td>
      <td>${esc(database.project_name)}</td>
      <td><span class="pill">${esc(database.kind)}</span></td>
      <td><span class="pill ${statusClass(database.status)}">${esc(database.status)}</span></td>
      <td class="mono">${esc(database.docker_name)}</td>
      <td class="mono">${esc(database.variable_key)}</td>
      <td><button data-db-backup="${esc(database.id)}">Backup now</button></td>
    </tr>
  `).join("");
  $("#content").innerHTML = `
    <div class="panel"><table class="table">
      <thead><tr><th>Database</th><th>Project</th><th>Type</th><th>Status</th><th>Internal host</th><th>Variable</th><th></th></tr></thead>
      <tbody>${body || '<tr><td colspan="7" class="empty">No managed databases yet. Add one from a project.</td></tr>'}</tbody>
    </table></div>
  `;
  $$("[data-db-backup]").forEach((button) => button.onclick = async () => {
    try {
      const queued = await api(`/api/databases/${button.dataset.dbBackup}/backup`, { method: "POST" });
      await pollCommand(queued.commandId, 30 * 60_000);
      alert("Database backup completed.");
      renderDatabases();
    } catch (error) { alert(error.message); }
  });
}

async function renderBackups() {
  const backups = await api("/api/backups");
  const body = backups.map((backup) => `
    <tr>
      <td><strong>${esc(backup.project_name || "Platform resource")}</strong><div class="mono muted">${esc(backup.id)}</div></td>
      <td>${esc(backup.kind)}</td>
      <td><span class="pill ${statusClass(backup.status)}">${esc(backup.status)}</span></td>
      <td>${backup.size_bytes ? Math.round(backup.size_bytes / 1024 / 1024) + " MB" : "—"}</td>
      <td>${fmt(backup.created_at)}</td>
      <td>${fmt(backup.restore_tested_at)}</td>
      <td>
        ${backup.status === "completed" ? `<button data-test-backup="${esc(backup.id)}">Test restore</button>` : ""}
        ${backup.status === "completed" && String(backup.kind).startsWith("database-") ? `<button data-restore-db="${esc(backup.id)}">Restore</button>` : ""}
        ${backup.status === "completed" && backup.kind === "volume" ? `<button data-restore-volume="${esc(backup.id)}">Restore</button>` : ""}
      </td>
    </tr>
  `).join("");

  $("#content").innerHTML = `
    <div class="panel"><table class="table">
      <thead><tr><th>Backup</th><th>Kind</th><th>Status</th><th>Size</th><th>Created</th><th>Restore tested</th><th></th></tr></thead>
      <tbody>${body || '<tr><td colspan="7" class="empty">No backups recorded yet.</td></tr>'}</tbody>
    </table></div>
  `;

  $$("[data-test-backup]").forEach((button) => button.onclick = async () => {
    try {
      const queued = await api(`/api/backups/${button.dataset.testBackup}/test`, { method: "POST" });
      await pollCommand(queued.commandId, 30 * 60_000);
      alert("Backup restore test passed.");
      renderBackups();
    } catch (error) { alert(error.message); }
  });

  $$("[data-restore-db]").forEach((button) => button.onclick = async () => {
    if (!confirm("This will stop the attached app and overwrite the database with this backup. Continue?")) return;
    try {
      const queued = await api(`/api/backups/${button.dataset.restoreDb}/restore-database`, {
        method: "POST", body: JSON.stringify({ confirm: "RESTORE_DATABASE" })
      });
      await pollCommand(queued.commandId, 30 * 60_000);
      alert("Database restored. Redeploy the attached application.");
    } catch (error) { alert(error.message); }
  });

  $$("[data-restore-volume]").forEach((button) => button.onclick = async () => {
    if (!confirm("This will stop the service and overwrite the persistent volume. Continue?")) return;
    try {
      const queued = await api(`/api/backups/${button.dataset.restoreVolume}/restore`, {
        method: "POST", body: JSON.stringify({ confirm: "RESTORE" })
      });
      await pollCommand(queued.commandId, 30 * 60_000);
      alert("Volume restored. Redeploy the service.");
    } catch (error) { alert(error.message); }
  });
}

async function renderAlerts() {
  const alerts = await api("/api/alerts");
  const body = alerts.map((alert) => `
    <tr>
      <td><span class="pill ${statusClass(alert.severity)}">${esc(alert.severity)}</span></td>
      <td><strong>${esc(alert.title)}</strong><div class="muted">${esc(alert.message)}</div></td>
      <td>${esc(alert.target_type || "—")} <span class="mono">${esc(alert.target_id || "")}</span></td>
      <td>${fmt(alert.created_at)}</td>
      <td>${alert.resolved_at ? `<span class="pill good">resolved</span> ${fmt(alert.resolved_at)}` : `<button data-resolve-alert="${esc(alert.id)}">Resolve</button>`}</td>
    </tr>
  `).join("");
  $("#content").innerHTML = `
    <div class="panel"><table class="table">
      <thead><tr><th>Severity</th><th>Alert</th><th>Target</th><th>Created</th><th>Status</th></tr></thead>
      <tbody>${body || '<tr><td colspan="5" class="empty">No alerts.</td></tr>'}</tbody>
    </table></div>
  `;
  $$("[data-resolve-alert]").forEach((button) => button.onclick = async () => {
    await api(`/api/alerts/${button.dataset.resolveAlert}/resolve`, { method: "POST" });
    renderAlerts();
  });
}

async function renderSecurity() {
  const { user } = await api("/api/auth/me");
  $("#content").innerHTML = `
    <div class="panel narrow">
      <div style="padding:22px">
        <div class="section-head no-top"><h3>Administrator security</h3></div>
        <div class="kv"><span class="muted">Email</span><span>${esc(user.email)}</span></div>
        <div class="kv"><span class="muted">Two-factor auth</span><span><span class="pill ${user.totp_enabled ? "good" : "warn"}">${user.totp_enabled ? "enabled" : "not enabled"}</span></span></div>
        ${user.totp_enabled ? "" : '<div class="row mt16"><button id="enroll-totp" class="primary">Set up authenticator</button></div>'}
        <div id="totp-setup"></div>
      </div>
    </div>
  `;
  if ($("#enroll-totp")) $("#enroll-totp").onclick = async () => {
    try {
      const enrollment = await api("/api/auth/totp/enroll", { method: "POST" });
      $("#totp-setup").innerHTML = `
        <div class="section-head"><h3>Authenticator setup</h3></div>
        <p class="muted">Add this secret to your authenticator app, then enter the six-digit code to confirm.</p>
        <div class="kv"><span class="muted">Secret</span><span class="mono">${esc(enrollment.secret)}</span></div>
        <div class="kv"><span class="muted">URI</span><span class="mono break-anywhere">${esc(enrollment.uri)}</span></div>
        <form id="confirm-totp" class="row" style="margin-top:16px">
          <input id="totp-confirm-code" inputmode="numeric" placeholder="123456" class="max180" required>
          <button class="primary">Enable 2FA</button>
        </form>
      `;
      $("#confirm-totp").onsubmit = async (event) => {
        event.preventDefault();
        await api("/api/auth/totp/confirm", {
          method: "POST", body: JSON.stringify({ token: $("#totp-confirm-code").value })
        });
        alert("Two-factor authentication enabled.");
        renderSecurity();
      };
    } catch (error) { alert(error.message); }
  };
}

async function renderAudit() {
  const rows = await api("/api/audit");
  $("#content").innerHTML = `
    <div class="panel"><table class="table">
      <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th></tr></thead>
      <tbody>${rows.map((row) => `
        <tr><td>${fmt(row.created_at)}</td><td class="mono">${esc(row.actor)}</td><td>${esc(row.action)}</td><td class="mono">${esc(row.target_type || "")} ${esc(row.target_id || "")}</td></tr>
      `).join("")}</tbody>
    </table></div>
  `;
}

async function openProject(id) {
  const project = await api(`/api/projects/${encodeURIComponent(id)}`);
  const service = project.services[0];
  if (!service) return;
  const dialog = $("#project-detail-dialog");

  const domains = service.domains.map((domain) => `
    <div class="kv">
      <span class="mono">${esc(domain.hostname)}</span>
      <span><span class="pill ${domain.verified ? "good" : "warn"}">${domain.verified ? "verified" : "waiting for DNS"}</span> <button data-verify-domain="${esc(domain.id)}">Verify</button></span>
    </div>
  `).join("") || '<div class="muted">No domains configured.</div>';

  const secrets = service.variables.map((variable) => `
    <span class="pill">${esc(variable.key)}</span>
  `).join(" ") || '<span class="muted">No environment variables yet.</span>';

  const volumes = (service.volumes || []).map((volume) => `
    <div class="kv">
      <span><strong>${esc(volume.name)}</strong><br><span class="mono muted">${esc(volume.mount_path)}</span></span>
      <span><button data-backup-volume="${esc(volume.id)}">Backup now</button> <span class="mono muted">${esc(volume.docker_volume_name)}</span></span>
    </div>
  `).join("") || '<div class="muted">No persistent volumes attached.</div>';

  const databases = (project.databases || []).map((database) => `
    <div class="kv">
      <span><strong>${esc(database.name)}</strong><br><span class="pill">${esc(database.kind)}</span></span>
      <span><span class="pill ${statusClass(database.status)}">${esc(database.status)}</span> <span class="mono">${esc(database.variable_key)}</span> <button data-project-db-backup="${esc(database.id)}">Backup</button></span>
    </div>
  `).join("") || '<div class="muted">No managed databases.</div>';

  $("#project-detail").innerHTML = `
    <div class="detail-head">
      <div>
        <div class="eyebrow">PROJECT</div>
        <h3>${esc(project.name)}</h3>
        <div class="muted mono">${esc(service.repo_full_name)} · ${esc(service.branch)}</div>
      </div>
      <button class="icon-btn" id="close-detail">×</button>
    </div>

    <div class="section-head"><h3>Service controls</h3></div>
    <div class="row">
      <button class="primary" id="deploy-now">Deploy now</button>
      <button id="restart-service">Restart</button>
      <button id="refresh-runtime-logs">Refresh live logs</button>
      <button id="stop-service" class="danger">Stop</button>
    </div>

    <div class="section-head"><h3>Build & runtime</h3></div>
    <form id="service-settings" class="form-grid">
      <label>Branch<input name="branch" value="${esc(service.branch)}" required></label>
      <label>Root directory<input name="rootDirectory" value="${esc(service.root_directory || ".")}" required></label>
      <label>Build type<select name="buildType">
        ${["auto","docker","node","python","static"].map((type) => `<option value="${type}" ${service.build_type === type ? "selected" : ""}>${type}</option>`).join("")}
      </select></label>
      <label>Internal port<input name="internalPort" type="number" min="1" max="65535" value="${esc(service.internal_port)}"></label>
      <label>Health path<input name="healthPath" value="${esc(service.health_path)}"></label>
      <label>CPU limit<input name="cpuLimit" type="number" min=".1" max="32" step=".1" value="${esc(service.cpu_limit)}"></label>
      <label>Memory MB<input name="memoryMb" type="number" min="64" value="${esc(service.memory_mb)}"></label>
      <label>Build command<input name="buildCommand" value="${esc(service.build_command || "")}" placeholder="auto"></label>
      <label>Start command<input name="startCommand" value="${esc(service.start_command || "")}" placeholder="auto"></label>
      <label>Pre-deploy / migration command<input name="predeployCommand" value="${esc(service.predeploy_command || "")}" placeholder="npx prisma migrate deploy"></label>
      <label><span>Automatic deploys</span><select name="autoDeploy"><option value="true" ${service.auto_deploy ? "selected" : ""}>Enabled</option><option value="false" ${!service.auto_deploy ? "selected" : ""}>Disabled</option></select></label>
      <div class="row align-end"><button class="primary" type="submit">Save settings</button></div>
    </form>

    <div class="section-head"><h3>Domains</h3></div>
    ${domains}
    <form id="add-domain-form" class="row mt12">
      <input id="new-domain" placeholder="app.example.com" required class="max320">
      <button>Add domain</button>
    </form>

    <div class="section-head"><h3>Environment secrets</h3></div>
    <div class="row">${secrets}</div>
    <form id="secret-form" class="form-grid mt12">
      <label>Variable<input id="secret-key" placeholder="DATABASE_URL" required></label>
      <label>Secret value<input id="secret-value" type="password" required></label>
      <div class="row"><button>Add / replace secret</button></div>
    </form>

    <div class="section-head"><h3>Persistent volumes</h3></div>
    ${volumes}
    <form id="volume-form" class="form-grid mt12">
      <label>Name<input id="volume-name" placeholder="uploads" required></label>
      <label>Mount path<input id="volume-path" placeholder="/app/uploads" required></label>
      <div class="row"><button>Add volume</button></div>
    </form>

    <div class="section-head"><h3>Managed databases</h3></div>
    ${databases}
    <form id="database-form" class="form-grid mt12">
      <label>Type<select id="database-kind"><option value="postgres">PostgreSQL</option><option value="redis">Redis</option></select></label>
      <label>Name<input id="database-name" placeholder="Production DB" required></label>
      <label>Environment variable<input id="database-variable" placeholder="DATABASE_URL"></label>
      <div class="row align-end"><button>Add database</button></div>
    </form>

    <div class="section-head"><h3>Deployment history</h3></div>
    ${deploymentTable(service.deployments.map((deployment) => ({ ...deployment, project_name: project.name, service_name: service.name })))}
  `;

  dialog.showModal();
  $("#close-detail").onclick = () => dialog.close();

  $("#deploy-now").onclick = async () => {
    try {
      await api(`/api/services/${service.id}/deploy`, { method: "POST" });
      dialog.close();
      state.view = "deployments";
      await renderDeployments();
    } catch (error) { alert(error.message); }
  };

  $("#restart-service").onclick = async () => {
    try {
      const queued = await api(`/api/services/${service.id}/restart`, { method: "POST" });
      await pollCommand(queued.commandId);
      alert("Service restarted.");
    } catch (error) { alert(error.message); }
  };

  $("#stop-service").onclick = async () => {
    if (!confirm("Stop this service and remove its public route?")) return;
    try {
      const queued = await api(`/api/services/${service.id}/stop`, { method: "POST" });
      await pollCommand(queued.commandId);
      alert("Service stopped.");
    } catch (error) { alert(error.message); }
  };

  $("#refresh-runtime-logs").onclick = async () => {
    try {
      const queued = await api(`/api/services/${service.id}/logs/refresh`, { method: "POST" });
      await pollCommand(queued.commandId);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await showLogs(queued.deploymentId);
    } catch (error) { alert(error.message); }
  };

  $("#service-settings").onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = {
      branch: String(form.get("branch")),
      rootDirectory: String(form.get("rootDirectory")),
      buildType: String(form.get("buildType")),
      internalPort: Number(form.get("internalPort")),
      healthPath: String(form.get("healthPath")),
      cpuLimit: Number(form.get("cpuLimit")),
      memoryMb: Number(form.get("memoryMb")),
      buildCommand: String(form.get("buildCommand") || "") || null,
      startCommand: String(form.get("startCommand") || "") || null,
      predeployCommand: String(form.get("predeployCommand") || "") || null,
      autoDeploy: String(form.get("autoDeploy")) === "true"
    };
    try {
      await api(`/api/services/${service.id}`, { method: "PATCH", body: JSON.stringify(body) });
      alert("Service settings saved.");
      openProject(id);
    } catch (error) { alert(error.message); }
  };

  $("#add-domain-form").onsubmit = async (event) => {
    event.preventDefault();
    try {
      await api(`/api/services/${service.id}/domains`, {
        method: "POST", body: JSON.stringify({ hostname: $("#new-domain").value })
      });
      openProject(id);
    } catch (error) { alert(error.message); }
  };

  $$("[data-verify-domain]", dialog).forEach((button) => button.onclick = async () => {
    try {
      await api(`/api/domains/${button.dataset.verifyDomain}/verify`, { method: "POST" });
      openProject(id);
    } catch (error) { alert(error.message); }
  });

  $("#secret-form").onsubmit = async (event) => {
    event.preventDefault();
    const key = $("#secret-key").value.trim();
    const value = $("#secret-value").value;
    try {
      await api(`/api/services/${service.id}/variables/${encodeURIComponent(key)}`, {
        method: "PUT", body: JSON.stringify({ value })
      });
      openProject(id);
    } catch (error) { alert(error.message); }
  };

  $("#volume-form").onsubmit = async (event) => {
    event.preventDefault();
    try {
      await api(`/api/services/${service.id}/volumes`, {
        method: "POST",
        body: JSON.stringify({ name: $("#volume-name").value, mountPath: $("#volume-path").value })
      });
      openProject(id);
    } catch (error) { alert(error.message); }
  };

  $$("[data-backup-volume]", dialog).forEach((button) => button.onclick = async () => {
    try {
      const queued = await api(`/api/volumes/${button.dataset.backupVolume}/backup`, { method: "POST" });
      await pollCommand(queued.commandId, 30 * 60_000);
      alert("Volume backup completed.");
      openProject(id);
    } catch (error) { alert(error.message); }
  });

  $("#database-form").onsubmit = async (event) => {
    event.preventDefault();
    const kind = $("#database-kind").value;
    const variableKey = $("#database-variable").value.trim() || (kind === "postgres" ? "DATABASE_URL" : "REDIS_URL");
    try {
      const queued = await api(`/api/projects/${project.id}/databases`, {
        method: "POST",
        body: JSON.stringify({
          kind,
          name: $("#database-name").value,
          serviceId: service.id,
          variableKey
        })
      });
      await pollCommand(queued.commandId, 15 * 60_000);
      openProject(id);
    } catch (error) { alert(error.message); }
  };

  $$("[data-project-db-backup]", dialog).forEach((button) => button.onclick = async () => {
    try {
      const queued = await api(`/api/databases/${button.dataset.projectDbBackup}/backup`, { method: "POST" });
      await pollCommand(queued.commandId, 30 * 60_000);
      alert("Database backup completed.");
      openProject(id);
    } catch (error) { alert(error.message); }
  });

  wireDeployments(dialog);
}

boot();
setInterval(() => {
  if (!$("#app").classList.contains("hidden") && state.view === "overview") renderOverview().catch(() => {});
}, 15000);
