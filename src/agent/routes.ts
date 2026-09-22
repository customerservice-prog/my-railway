import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { env } from "../shared/env.js";

const routesDir = env("TRAEFIK_ROUTES_DIR", "/var/lib/myrailway/routes");

function safeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

export async function activateRoute(serviceId: string, containerName: string, port: number, domains: string[]): Promise<void> {
  await fs.mkdir(routesDir, { recursive: true });
  const sid = safeId(serviceId);
  const target = path.join(routesDir, `${sid}.yml`);
  if (!domains.length) {
    await fs.rm(target, { force: true });
    return;
  }
  const rule = domains.map((domain) => `Host(\`${domain}\`)`).join(" || ");
  const document = {
    http: {
      routers: {
        [`router-${sid}`]: {
          rule,
          entryPoints: ["websecure"],
          service: `service-${sid}`,
          tls: { certResolver: "letsencrypt" }
        }
      },
      services: {
        [`service-${sid}`]: {
          loadBalancer: {
            passHostHeader: true,
            servers: [{ url: `http://${containerName}:${port}` }]
          }
        }
      }
    }
  };
  const temp = target + ".tmp";
  await fs.writeFile(temp, YAML.stringify(document), { mode: 0o644 });
  await fs.rename(temp, target);
}

export async function removeRoute(serviceId: string): Promise<void> {
  const target = path.join(routesDir, `${safeId(serviceId)}.yml`);
  await fs.rm(target, { force: true });
}
