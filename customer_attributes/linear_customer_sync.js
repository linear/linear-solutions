#!/usr/bin/env node
/**
 * Synchronize Linear customer attributes from a CSV file.
 *
 * Usage:
 *   node linear_customer_sync.js --csv /path/to/customers.csv --api-key <linear-api-key>
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const LINEAR_API_URL = "https://api.linear.app/graphql";
const MAX_PAGE_SIZE = 200;
const MAX_RETRIES = 5;
const RATE_LIMIT_STATUS = 429;
const REQUEST_TIMEOUT_MS = 20_000;
const BACKOFF_FACTOR = 2;

function normalizeKey(value) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function ensureNodeFetch() {
  if (typeof fetch !== "function") {
    console.error("This script requires Node.js 18 or later (fetch API support).");
    process.exit(1);
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (current === "--help" || current === "-h") {
      args.help = true;
      continue;
    }
    if (current === "--csv") {
      const next = argv[i + 1];
      if (!next) {
        throw new Error("Missing value after --csv");
      }
      args.csvPath = next;
      i += 1;
      continue;
    }
    if (current === "--api-key") {
      const next = argv[i + 1];
      if (!next) {
        throw new Error("Missing value after --api-key");
      }
      args.apiKey = next;
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${current}`);
  }
  return args;
}

function printUsage() {
  console.log(`Usage: node linear_customer_sync.js --csv /absolute/path/to/customers.csv [--api-key <linear-api-key>]

Options:
  --csv       (required) Path to the customer CSV file.
  --api-key   Linear API key. If omitted, you will be prompted securely.
  --help      Show this message.
`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function promptForApiKey(prompt) {
  const { stdin } = process;
  if (stdin.isTTY) {
    return new Promise((resolve) => {
      process.stdout.write(prompt);
      stdin.resume();
      stdin.setRawMode(true);

      let input = "";

      const cleanup = () => {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener("data", onData);
      };

      const onData = (chunk) => {
        const char = chunk.toString("utf8");
        if (char === "\n" || char === "\r" || char === "\u0004") {
          cleanup();
          process.stdout.write("\n");
          resolve(input.trim());
        } else if (char === "\u0003") {
          cleanup();
          process.stdout.write("\n");
          process.exit(1);
        } else if (char === "\u007f") {
          input = input.slice(0, -1);
        } else {
          input += char;
        }
      };

      stdin.on("data", onData);
    });
  }

  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (char === '"' && line[i + 1] === '"' && inQuotes) {
      current += '"';
      i += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current);
  return values.map((value) => value.trim());
}

function parseCsv(content) {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return [];
  }

  const header = parseCsvLine(lines[0]);
  const requiredIndex = header.indexOf("name");
  if (requiredIndex === -1) {
    throw new Error("CSV must include a 'name' column in the header row.");
  }

  const records = [];

  for (let i = 1; i < lines.length; i += 1) {
    const values = parseCsvLine(lines[i]);
    if (values.length === 0) {
      continue;
    }

    if (values.length !== header.length) {
      throw new Error(`Row ${i + 1} does not match the header column count.`);
    }

    const row = {};
    header.forEach((column, index) => {
      row[column] = values[index] ?? "";
    });

    const name = (row["name"] || "").trim();
    if (!name) {
      continue;
    }

    const record = { name };
    const optionalColumns = [
      "domains",
      "owner",
      "owner_id",
      "status",
      "status_id",
      "tier",
      "tier_id",
      "annual_revenue",
      "revenue",
      "size",
    ];

    optionalColumns.forEach((column) => {
      const value = (row[column] || "").trim();
      if (value) {
        record[column] = value;
      }
    });

    records.push(record);
  }

  return records;
}

function normalizeDomains(value) {
  return value
    .split(/[,;|]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseInteger(value) {
  if (!value) {
    return null;
  }
  const numeric = Number.parseInt(value.replace(/[^0-9.-]/g, ""), 10);
  return Number.isFinite(numeric) ? numeric : null;
}

function parseNumeric(value) {
  if (!value) {
    return null;
  }
  const numeric = Number.parseFloat(value.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(numeric) ? numeric : null;
}

function buildUpdatePayload(record, lookups) {
  const payload = {};
  const warnings = [];

  if (record.domains) {
    const domains = normalizeDomains(record.domains);
    if (domains.length > 0) {
      payload.domains = domains;
    }
  }

  const ownerId = record.owner_id
    ? record.owner_id
    : record.owner
    ? lookups.ownerByEmail.get(record.owner.toLowerCase()) ||
      lookups.ownerByName.get(normalizeKey(record.owner))
    : undefined;
  if (ownerId) {
    payload.ownerId = ownerId;
  } else if (record.owner || record.owner_id) {
    const ownersPreview = lookups.availableOwnerEmails
      .slice(0, 5)
      .concat(
        lookups.availableOwners.filter(
          (name) => !lookups.availableOwnerEmails.includes(name)
        )
      )
      .slice(0, 5)
      .join(", ");
    warnings.push(
      `  • Owner value "${record.owner || record.owner_id}" did not match any Linear user.` +
        (ownersPreview ? ` Examples: ${ownersPreview}${lookups.availableOwnerEmails.length + lookups.availableOwners.length > 5 ? "…" : ""}` : "")
    );
  }

  const statusId = record.status_id
    ? record.status_id
    : record.status
    ? lookups.statusByName.get(normalizeKey(record.status))
    : undefined;
  if (statusId) {
    payload.statusId = statusId;
  } else if (record.status || record.status_id) {
    const statusesPreview = lookups.availableStatuses.slice(0, 5).join(", ");
    warnings.push(
      `  • Status value "${record.status || record.status_id}" did not match any Linear customer status.` +
        (statusesPreview
          ? ` Available statuses: ${statusesPreview}${lookups.availableStatuses.length > 5 ? "…" : ""}`
          : "")
    );
  }

  const tierId = record.tier_id
    ? record.tier_id
    : record.tier
    ? lookups.tierByName.get(normalizeKey(record.tier))
    : undefined;
  if (tierId) {
    payload.tierId = tierId;
  } else if (record.tier || record.tier_id) {
    const tiersPreview = lookups.availableTiers.slice(0, 5).join(", ");
    warnings.push(
      `  • Tier value "${record.tier || record.tier_id}" did not match any Linear customer tier.` +
        (tiersPreview
          ? ` Available tiers: ${tiersPreview}${lookups.availableTiers.length > 5 ? "…" : ""}`
          : "")
    );
  }

  const revenueValue = record.revenue || record.annual_revenue;
  const revenue = parseNumeric(revenueValue);
  if (revenue !== null) {
    payload.revenue = revenue;
  } else if (record.revenue || record.annual_revenue) {
    warnings.push(
      `  • Revenue value "${record.revenue || record.annual_revenue}" could not be parsed as a number.`
    );
  }

  const size = parseInteger(record.size);
  if (size !== null) {
    payload.size = size;
  } else if (record.size) {
    warnings.push(
      `  • Size value "${record.size}" could not be parsed as an integer.`
    );
  }
  return { payload, warnings };
}

async function graphqlRequest(query, variables, apiKey, attempt = 1) {
  ensureNodeFetch();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });

    if (response.status === RATE_LIMIT_STATUS) {
      if (attempt >= MAX_RETRIES) {
        throw new Error("Linear API rate limit exceeded after retries.");
      }
      const retryAfterHeader = response.headers.get("Retry-After");
      const retrySeconds = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : 0;
      const delayMs =
        Number.isFinite(retrySeconds) && retrySeconds > 0
          ? retrySeconds * 1_000
          : BACKOFF_FACTOR ** attempt * 1_000;
      await delay(delayMs);
      return graphqlRequest(query, variables, apiKey, attempt + 1);
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Linear API request failed (${response.status}): ${text}`);
    }

    const data = await response.json();
    if (data.errors && data.errors.length > 0) {
      const message = data.errors.map((error) => error.message).join("; ");
      throw new Error(message);
    }

    return data.data;
  } catch (error) {
    if (attempt >= MAX_RETRIES) {
      throw error;
    }
    await delay(BACKOFF_FACTOR ** attempt * 1_000);
    return graphqlRequest(query, variables, apiKey, attempt + 1);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchExistingCustomers(apiKey) {
  const customersByName = new Map();
  const ownerByEmail = new Map();
  const ownerEmails = new Set();
  const ownerByName = new Map();
  const ownerNames = new Set();
  const statusByName = new Map();
  const statusNames = new Set();
  let after = undefined;

  const query = `
    query Customers($after: String) {
      customers(first: ${MAX_PAGE_SIZE}, after: $after) {
        nodes {
          id
          name
          owner {
            id
            name
            email
          }
          status {
            id
            name
            displayName
          }
          tier {
            id
            name
            displayName
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  while (true) {
    const data = await graphqlRequest(query, { after }, apiKey);

    data.customers.nodes.forEach((customer) => {
      customersByName.set(customer.name, customer.id);

      if (customer.owner) {
        if (customer.owner.email) {
          ownerByEmail.set(customer.owner.email.toLowerCase(), customer.owner.id);
          ownerEmails.add(customer.owner.email);
        }
        if (customer.owner.name) {
          ownerByName.set(normalizeKey(customer.owner.name), customer.owner.id);
          ownerNames.add(customer.owner.name);
        }
      }

      if (customer.status && customer.status.id) {
        const statusNamesToRecord = [
          customer.status.name,
          customer.status.displayName,
        ].filter(Boolean);
        statusNamesToRecord.forEach((statusName) => {
          const key = normalizeKey(statusName);
          if (!statusByName.has(key)) {
            statusByName.set(key, customer.status.id);
          }
          statusNames.add(statusName);
        });
      }
    });

    const pageInfo = data.customers.pageInfo;
    if (!pageInfo.hasNextPage) {
      break;
    }
    after = pageInfo.endCursor;
  }

  return {
    customersByName,
    ownerByEmail,
    ownerByName,
    ownerNames: Array.from(ownerNames).sort(),
    ownerEmails: Array.from(ownerEmails).sort(),
    statusByName,
    statusNames: Array.from(statusNames).sort(),
  };
}

async function updateCustomer(apiKey, customerId, attributes) {
  const mutation = `
    mutation UpdateCustomer($id: String!, $input: CustomerUpdateInput!) {
      customerUpdate(id: $id, input: $input) {
        success
      }
    }
  `;

  const result = await graphqlRequest(mutation, { id: customerId, input: attributes }, apiKey);

  if (!result.customerUpdate.success) {
    throw new Error(`Update failed for customer id ${customerId}`);
  }
}

async function fetchUsers(apiKey) {
  const usersByEmail = new Map();
  const usersByName = new Map();
  const userNames = new Set();
  const userEmails = new Set();
  let after = undefined;

  const query = `
    query Users($after: String) {
      users(first: ${MAX_PAGE_SIZE}, after: $after) {
        nodes {
          id
          name
          email
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  while (true) {
    const data = await graphqlRequest(query, { after }, apiKey);

    data.users.nodes.forEach((user) => {
      if (user.email) {
        usersByEmail.set(user.email.toLowerCase(), user.id);
        userEmails.add(user.email);
      }
      if (user.name) {
        usersByName.set(normalizeKey(user.name), user.id);
        userNames.add(user.name);
      }
    });

    const pageInfo = data.users.pageInfo;
    if (!pageInfo.hasNextPage) {
      break;
    }
    after = pageInfo.endCursor;
  }

  return {
    usersByEmail,
    usersByName,
    userNames: Array.from(userNames).sort(),
    userEmails: Array.from(userEmails).sort(),
  };
}

async function fetchCustomerMetadata(apiKey) {
  const statusByName = new Map();
  const statusNames = new Set();
  const tierByName = new Map();
  const tierNames = new Set();

  let statusesAfter = undefined;
  let tiersAfter = undefined;
  let statusesComplete = false;
  let tiersComplete = false;

  const query = `
    query CustomerMetadata(
      $statusesAfter: String,
      $tiersAfter: String,
      $skipStatuses: Boolean!,
      $skipTiers: Boolean!
    ) {
      customerStatuses(
        first: ${MAX_PAGE_SIZE},
        after: $statusesAfter,
        includeArchived: false
      ) @skip(if: $skipStatuses) {
        nodes {
          id
          name
          displayName
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
      customerTiers(
        first: ${MAX_PAGE_SIZE},
        after: $tiersAfter,
        includeArchived: false
      ) @skip(if: $skipTiers) {
        nodes {
          id
          name
          displayName
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  while (!statusesComplete || !tiersComplete) {
    const data = await graphqlRequest(
      query,
      {
        statusesAfter,
        tiersAfter,
        skipStatuses: statusesComplete,
        skipTiers: tiersComplete,
      },
      apiKey
    );

    if (!statusesComplete && data.customerStatuses) {
      const { nodes, pageInfo } = data.customerStatuses;
      nodes.forEach((status) => {
        if (!status) {
          return;
        }
        const namesToRecord = [status.name, status.displayName].filter(Boolean);
        namesToRecord.forEach((statusName) => {
          const key = normalizeKey(statusName);
          if (!statusByName.has(key)) {
            statusByName.set(key, status.id);
          }
          statusNames.add(statusName);
        });
      });

      if (pageInfo.hasNextPage) {
        statusesAfter = pageInfo.endCursor;
      } else {
        statusesComplete = true;
      }
    }

    if (!tiersComplete && data.customerTiers) {
      const { nodes, pageInfo } = data.customerTiers;
      nodes.forEach((tier) => {
        if (!tier) {
          return;
        }
        const namesToRecord = [tier.name, tier.displayName].filter(Boolean);
        namesToRecord.forEach((tierName) => {
          const key = normalizeKey(tierName);
          if (!tierByName.has(key)) {
            tierByName.set(key, tier.id);
          }
          tierNames.add(tierName);
        });
      });

      if (pageInfo.hasNextPage) {
        tiersAfter = pageInfo.endCursor;
      } else {
        tiersComplete = true;
      }
    }
  }

  return {
    statusByName,
    statusNames: Array.from(statusNames).sort(),
    tierByName,
    tierNames: Array.from(tierNames).sort(),
  };
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));

    if (args.help) {
      printUsage();
      return 0;
    }

    if (!args.csvPath) {
      printUsage();
      return 1;
    }

    const resolvedCsvPath = path.resolve(args.csvPath);
    if (!fs.existsSync(resolvedCsvPath)) {
      console.error(`CSV file not found: ${resolvedCsvPath}`);
      return 1;
    }

    const csvContent = fs.readFileSync(resolvedCsvPath, "utf8");
    const records = parseCsv(csvContent);
    if (records.length === 0) {
      console.log("No valid rows found in the CSV. Nothing to update.");
      return 0;
    }

    let apiKey = (args.apiKey || "").trim();
    if (!apiKey) {
      apiKey = await promptForApiKey("Enter your Linear API key: ");
    }

    if (!apiKey) {
      console.error("Linear API key is required.");
      return 1;
    }

    const existingData = await fetchExistingCustomers(apiKey);
    const userLookups = await fetchUsers(apiKey);
    const metadataLookups = await fetchCustomerMetadata(apiKey);

    const ownerByEmail = new Map(userLookups.usersByEmail);
    existingData.ownerByEmail.forEach((value, key) => {
      if (!ownerByEmail.has(key)) {
        ownerByEmail.set(key, value);
      }
    });

    const ownerByName = new Map(userLookups.usersByName);
    existingData.ownerByName.forEach((value, key) => {
      if (!ownerByName.has(key)) {
        ownerByName.set(key, value);
      }
    });

    const ownerNamesSet = new Set([
      ...userLookups.userNames,
      ...existingData.ownerNames,
    ]);
    const ownerEmailsSet = new Set([
      ...userLookups.userEmails,
      ...existingData.ownerEmails,
    ]);

    const statusByName = new Map(metadataLookups.statusByName);
    existingData.statusByName.forEach((value, key) => {
      if (!statusByName.has(key)) {
        statusByName.set(key, value);
      }
    });

    const availableStatuses = Array.from(
      new Set([...metadataLookups.statusNames, ...existingData.statusNames])
    ).sort();

    const lookups = {
      ownerByEmail,
      ownerByName,
      statusByName,
      tierByName: metadataLookups.tierByName,
      availableOwners: Array.from(ownerNamesSet).sort(),
      availableOwnerEmails: Array.from(ownerEmailsSet).sort(),
      availableStatuses,
      availableTiers: metadataLookups.tierNames,
    };

    let updated = 0;
    let skipped = 0;

    for (const record of records) {
      const customerId = existingData.customersByName.get(record.name);
      if (!customerId) {
        skipped += 1;
        continue;
      }

      const { payload, warnings } = buildUpdatePayload(record, lookups);
      const payloadKeys = Object.keys(payload);
      if (payloadKeys.length === 0) {
        skipped += 1;
        if (warnings.length > 0) {
          console.log(
            `Skipped "${record.name}" because no valid attributes were found:\n${warnings.join(
              "\n"
            )}`
          );
        }
        continue;
      }

      try {
        await updateCustomer(apiKey, customerId, payload);
        updated += 1;
        if (warnings.length > 0) {
          console.log(
            `Updated "${record.name}" with partial attributes:\n${warnings.join(
              "\n"
            )}`
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Failed to update "${record.name}": ${message}`);
      }
    }

    console.log(`Customers updated: ${updated}`);
    if (skipped > 0) {
      console.log(`Customers skipped (no match or no attributes to update): ${skipped}`);
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    return 1;
  }
}

main().then((code) => {
  if (code !== 0) {
    process.exit(code);
  }
});


