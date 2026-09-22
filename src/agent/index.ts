import { env } from "../shared/env.js";
import { sleep } from "../shared/util.js";
import { backupVolume, deploy, restartService, restoreVolume, runtimeStats, stopService, testVolumeBackup, type DeployPayload } from "./docker.js";

const control = env("CONTROL_PLANE_URL", "http://localhost:8080").replace(/\/$/,"");
const token = env("AGENT_TOKEN");
const serverId = env("SERVER_ID", "runtime-01");
const serverName = env("SERVER_NAME", serverId);
const agentVersion = "0.1.0";

async function request(path: string, init: RequestInit = {}) {
  return fetch(control + path, {
    ...init,
    headers: {
      "content-type":"application/json",
      "authorization":`Bearer ${token}`,
      ...(init.headers ?? {})
    }
  });
}

async function heartbeat() {
  const stats = await runtimeStats();
  const response = await request("/api/internal/agent/heartbeat", {
    method:"POST",
    body:JSON.stringify({ id:serverId, name:serverName, agentVersion, ...stats })
  });
  if (!response.ok) throw new Error(`heartbeat failed: ${response.status}`);
}

async function claim() {
  const response = await request("/api/internal/agent/commands/claim", {
    method:"POST",
    body:JSON.stringify({serverId})
  });
  if (response.status === 204) return null;
  if (!response.ok) throw new Error(`claim failed: ${response.status}`);
  return response.json() as Promise<any>;
}

async function complete(id: string, ok: boolean, result: unknown) {
  const response = await request(`/api/internal/agent/commands/${id}/complete`, {
    method:"POST",
    body:JSON.stringify({ok,result})
  });
  if (!response.ok) throw new Error(`command completion failed: ${response.status}`);
}

async function execute(command: any) {
  switch (command.action) {
    case "DEPLOY": return deploy(command.payload as DeployPayload);
    case "STOP": return stopService(String(command.payload.serviceId));
    case "RESTART": return restartService(String(command.payload.serviceId));
    case "BACKUP_VOLUME": return backupVolume(String(command.payload.volumeName), String(command.payload.backupName));
    case "TEST_VOLUME_BACKUP": return testVolumeBackup(String(command.payload.fileName));
    case "RESTORE_VOLUME": return restoreVolume(String(command.payload.volumeName), String(command.payload.fileName), command.payload.serviceId ? String(command.payload.serviceId) : undefined);
    default: throw new Error(`unknown command: ${command.action}`);
  }
}

async function main() {
  console.log(`My Railway agent ${agentVersion} starting as ${serverId}`);
  let lastHeartbeat = 0;
  for (;;) {
    try {
      if (Date.now() - lastHeartbeat > 10_000) {
        await heartbeat();
        lastHeartbeat = Date.now();
      }
      const command = await claim();
      if (!command) {
        await sleep(1500);
        continue;
      }
      try {
        const result = await execute(command);
        await complete(command.id, true, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Command ${command.id} failed:`, message);
        await complete(command.id, false, {error:message});
      }
    } catch (error) {
      console.error(error);
      await sleep(5000);
    }
  }
}

main().catch((error)=>{ console.error(error); process.exit(1); });
