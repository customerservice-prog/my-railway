import { Redis } from "ioredis";
import { Queue } from "bullmq";
import { env } from "./env.js";

export const redis = new Redis(env("REDIS_URL", "redis://localhost:6379"), {
  maxRetriesPerRequest: null,
  enableReadyCheck: true
});

export const deploymentQueue = new Queue("deployments", { connection: redis });

export async function enqueueDeployment(deploymentId: string): Promise<void> {
  await deploymentQueue.add("deploy", { deploymentId }, {
    jobId: deploymentId,
    attempts: 2,
    backoff: { type: "exponential", delay: 3000 },
    removeOnComplete: 200,
    removeOnFail: 500
  });
}
