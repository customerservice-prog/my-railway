import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

export type ServiceBuildConfig = {
  build_type: "auto"|"docker"|"node"|"python"|"static";
  dockerfile_path: string;
  build_command: string | null;
  start_command: string | null;
  internal_port: number;
};

export async function run(command: string, args: string[], cwd: string, onLine: (line:string)=>Promise<void>|void, env?: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore","pipe","pipe"] });
    let stdout = "";
    let stderr = "";
    const emit = (chunk: Buffer, kind: "stdout"|"stderr") => {
      const text = chunk.toString();
      if (kind === "stdout") stdout += text; else stderr += text;
      for (const line of text.split(/\r?\n/).filter(Boolean)) void onLine(line);
    };
    child.stdout.on("data", (c) => emit(c, "stdout"));
    child.stderr.on("data", (c) => emit(c, "stderr"));
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}: ${stderr.slice(-2000) || stdout.slice(-2000)}`)));
  });
}

async function exists(file: string): Promise<boolean> {
  try { await fs.access(file); return true; } catch { return false; }
}

export async function prepareDockerfile(workdir: string, service: ServiceBuildConfig): Promise<{ dockerfile: string; detected: string }> {
  const configured = path.join(workdir, service.dockerfile_path || "Dockerfile");
  if (service.build_type === "docker" || (service.build_type === "auto" && await exists(configured))) {
    if (!await exists(configured)) throw new Error(`Dockerfile not found: ${service.dockerfile_path}`);
    return { dockerfile: configured, detected: "docker" };
  }

  let type = service.build_type;
  if (type === "auto") {
    if (await exists(path.join(workdir, "package.json"))) type = "node";
    else if (await exists(path.join(workdir, "requirements.txt")) || await exists(path.join(workdir, "pyproject.toml"))) type = "python";
    else if (await exists(path.join(workdir, "index.html"))) type = "static";
    else throw new Error("Unable to auto-detect project. Add a Dockerfile or select a build type.");
  }

  const generated = path.join(workdir, ".myrailway.Dockerfile");
  if (type === "node") {
    const pkg = JSON.parse(await fs.readFile(path.join(workdir, "package.json"), "utf8"));
    const hasBuild = Boolean(pkg.scripts?.build);
    const buildCommand = service.build_command || (hasBuild ? "npm run build" : null);
    const startCommand = service.start_command || (pkg.scripts?.start ? "npm start" : null);
    if (!startCommand) throw new Error("Node app has no start script. Configure startCommand or add scripts.start.");
    const dockerfile = [
      "FROM node:22-bookworm-slim",
      "WORKDIR /app",
      "COPY package*.json ./",
      "RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi",
      "COPY . .",
      buildCommand ? `RUN ${buildCommand}` : "",
      `ENV PORT=${service.internal_port}`,
      `EXPOSE ${service.internal_port}`,
      `CMD ["sh","-lc",${JSON.stringify(startCommand)}]`
    ].filter(Boolean).join("\n") + "\n";
    await fs.writeFile(generated, dockerfile);
    return { dockerfile: generated, detected: "node" };
  }

  if (type === "python") {
    const startCommand = service.start_command || `python app.py`;
    const install = await exists(path.join(workdir, "requirements.txt"))
      ? "RUN pip install --no-cache-dir -r requirements.txt"
      : "RUN pip install --no-cache-dir .";
    const dockerfile = [
      "FROM python:3.13-slim",
      "WORKDIR /app",
      "COPY . .",
      install,
      service.build_command ? `RUN ${service.build_command}` : "",
      `ENV PORT=${service.internal_port}`,
      `EXPOSE ${service.internal_port}`,
      `CMD ["sh","-lc",${JSON.stringify(startCommand)}]`
    ].filter(Boolean).join("\n") + "\n";
    await fs.writeFile(generated, dockerfile);
    return { dockerfile: generated, detected: "python" };
  }

  if (type === "static") {
    const dockerfile = [
      "FROM nginx:1.27-alpine",
      "COPY . /usr/share/nginx/html",
      "EXPOSE 80"
    ].join("\n") + "\n";
    await fs.writeFile(generated, dockerfile);
    return { dockerfile: generated, detected: "static" };
  }

  throw new Error(`Unsupported build type: ${type}`);
}
