/**
 * me.ts
 * --------------
 * Quick use of API to obtain name of user, e.g., whoami
 * Co-generated Craig Lewis & Chatgpt\
 *
 * Usage:
 *   npx ts-node src/me.ts
 *
 *   Requires Linear API key in .env file
 *
 */

import { getLinearClient } from "./linearClient";

async function main() {
  const client = getLinearClient(); // construct AFTER validation

  const me = await client.viewer;
  console.log({ id: me.id, name: me.name, email: me.email });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
