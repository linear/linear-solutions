/**
 * myIssues.ts
 * --------------
 * List all issues assigned to the authenticated user
 *
 * Usage:
 *   npx ts-node src/myIssues.ts
 *   npm run my-issues
 *
 * Requires Linear API key in .env file
 */

import { getLinearClient } from "./linearClient";

// Uncomment next two lines if your Node version lacks global fetch
// import fetch from "cross-fetch";
// (globalThis as any).fetch ??= fetch;

/**
 * Resolve relations returned by the SDK.
 * Relations can be: a relation function, a promise, or a resolved object.
 */
async function resolveRelation<T = any>(rel: any): Promise<T | null> {
  if (!rel) return null;
  if (typeof rel === "function") return await rel();
  if (typeof rel.then === "function") return await rel;
  return rel;
}

async function main() {
  const client = getLinearClient();

  const me = await client.viewer;
  console.log(`Viewer: ${me.name} <${me.email}> (id: ${me.id})\n`);
  console.log("Issues assigned to you:\n");

  let cursor: string | null | undefined = undefined;
  let totalCount = 0;

  do {
    const page = await client.issues({
      first: 50,
      after: cursor ?? undefined,
      filter: {
        assignee: { id: { eq: me.id } },
        // Include archived issues (no archivedAt filter)
      },
    });

    for (const issue of page.nodes) {
      totalCount += 1;
      const identifier = issue.identifier ?? "<no-id>";
      const title = issue.title ?? "<untitled>";

      // Resolve state relation
      const stateObj = await resolveRelation(issue.state);
      const state = stateObj?.name ?? "(No State)";

      // Format: [identifier] title [state]
      console.log(`${identifier} ${title} [${state}]`);
    }

    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  console.log(`\nTotal issues: ${totalCount}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
