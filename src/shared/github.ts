import jwt from "jsonwebtoken";
import { optionalEnv } from "./env.js";

let cached: { token:string; expiresAt:number } | null = null;

export async function getGitHubCloneToken(): Promise<string | undefined> {
  const staticToken = optionalEnv("GITHUB_TOKEN");
  if (staticToken) return staticToken;

  const appId = optionalEnv("GITHUB_APP_ID");
  const installationId = optionalEnv("GITHUB_APP_INSTALLATION_ID");
  const keyB64 = optionalEnv("GITHUB_APP_PRIVATE_KEY_BASE64");
  if (!appId || !installationId || !keyB64) return undefined;

  if (cached && cached.expiresAt > Date.now() + 5 * 60_000) return cached.token;

  const privateKey = Buffer.from(keyB64, "base64").toString("utf8");
  const now = Math.floor(Date.now()/1000);
  const appJwt = jwt.sign(
    { iat:now-60, exp:now+9*60, iss:appId },
    privateKey,
    { algorithm:"RS256" }
  );

  const response = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method:"POST",
    headers:{
      authorization:`Bearer ${appJwt}`,
      accept:"application/vnd.github+json",
      "x-github-api-version":"2022-11-28",
      "user-agent":"my-railway"
    },
    signal:AbortSignal.timeout(15_000)
  });
  if(!response.ok) {
    const body=await response.text();
    throw new Error(`GitHub App token request failed (${response.status}): ${body.slice(0,500)}`);
  }
  const data=await response.json() as {token:string;expires_at:string};
  cached={token:data.token,expiresAt:new Date(data.expires_at).getTime()};
  return cached.token;
}

export function gitHubAuthEnvironment(token?: string): NodeJS.ProcessEnv {
  if(!token) return {};
  return {
    GIT_CONFIG_COUNT:"1",
    GIT_CONFIG_KEY_0:"http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0:`Authorization: Bearer ${token}`
  };
}
