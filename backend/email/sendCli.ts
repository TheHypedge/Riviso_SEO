import { config as loadEnv } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  sendPasswordResetEmail,
  sendPlanNotificationEmail,
  sendVerificationEmail,
} from "./emailService";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../.env") });
loadEnv({ path: resolve(here, "../../.env") });

type Kind = "verification" | "password_reset" | "plan_notification";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const kind = (args[0] || "") as Kind;
  const to = (args[1] || "").trim();
  const tokenOrPlan = (args[2] || "").trim();
  if (!kind || !to) {
    console.error("Usage: sendCli.ts <verification|password_reset|plan_notification> <to> <token|planName>");
    process.exit(2);
  }
  if (kind === "verification") {
    await sendVerificationEmail(to, tokenOrPlan);
  } else if (kind === "password_reset") {
    await sendPasswordResetEmail(to, tokenOrPlan);
  } else if (kind === "plan_notification") {
    await sendPlanNotificationEmail(to, tokenOrPlan);
  } else {
    console.error("Unknown email kind");
    process.exit(2);
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(msg.replace(/pass[^\s]*/gi, "[redacted]"));
  process.exit(1);
});
