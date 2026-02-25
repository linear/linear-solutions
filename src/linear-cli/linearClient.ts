import * as dotenv from "dotenv";
import * as path from "path";
import { LinearClient } from "@linear/sdk";

// Load .env from repository root regardless of script subdirectory.
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

export function getLinearClient(): LinearClient {
  const apiKey = (process.env.LINEAR_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new Error("Missing or empty LINEAR_API_KEY (check .env)");
  }

  return new LinearClient({ apiKey });
}
