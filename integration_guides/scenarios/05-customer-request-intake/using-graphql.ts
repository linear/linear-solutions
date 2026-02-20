/**
 * Customer Request Intake - Raw GraphQL
 *
 * This guide demonstrates how to:
 * 1. Upsert a customer from external system data
 * 2. Create an issue with labels in Triage
 * 3. Attach a customer request to the issue
 *
 * Using raw GraphQL queries against Linear's API.
 *
 * This extends an existing intake flow (e.g., HubSpot → Linear) by adding
 * customer request creation alongside issue creation.
 *
 * BEFORE USING: Replace these placeholders with your values:
 * - <YOUR_ACCESS_TOKEN> → Your OAuth token (lin_oauth_...) or API key (lin_api_...)
 * - <YOUR_TEAM_ID> → Target team's UUID
 */

// =============================================================================
// GRAPHQL CLIENT
// =============================================================================

async function linearQuery<T>(
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const response = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      Authorization: "<YOUR_ACCESS_TOKEN>",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  const result = await response.json();

  if (result.errors?.length) {
    throw new Error(result.errors[0].message);
  }

  return result.data;
}

// =============================================================================
// 1. UPSERT CUSTOMER
// =============================================================================

/**
 * Upsert a customer using their domain and an external ID.
 *
 * - If a customer with the domain already exists, merges the externalId
 *   into the existing record (no duplicate created).
 * - If no match, creates a new customer.
 *
 * This is safe to call every time—no need to check existence first.
 */
const UPSERT_CUSTOMER = `
  mutation CustomerUpsert($input: CustomerUpsertInput!) {
    customerUpsert(input: $input) {
      success
      customer {
        id
        name
        domains
        externalIds
      }
    }
  }
`;

interface UpsertCustomerParams {
  name?: string;
  domains: string[];
  externalId: string;
}

async function upsertCustomer(
  params: UpsertCustomerParams
): Promise<{ id: string; name: string }> {
  const result = await linearQuery<{
    customerUpsert: {
      success: boolean;
      customer: { id: string; name: string; domains: string[] };
    };
  }>(UPSERT_CUSTOMER, {
    input: {
      name: params.name,
      domains: params.domains,
      externalId: params.externalId,
    },
  });

  return result.customerUpsert.customer;
}

// =============================================================================
// 2. CREATE ISSUE IN TRIAGE
// =============================================================================

/**
 * Find the Triage workflow state for a team.
 *
 * Issues placed in Triage give teams an inbox to review before backlog.
 * This is the recommended target state for programmatically-created issues.
 */
const FIND_WORKFLOW_STATES = `
  query FindWorkflowStates($teamId: ID!) {
    workflowStates(filter: { team: { id: { eq: $teamId } } }) {
      nodes {
        id
        name
        type
      }
    }
  }
`;

async function findTriageState(teamId: string): Promise<string | undefined> {
  const result = await linearQuery<{
    workflowStates: { nodes: { id: string; name: string; type: string }[] };
  }>(FIND_WORKFLOW_STATES, { teamId });

  const states = result.workflowStates.nodes;

  const triageByType = states.find((s) => s.type === "triage");
  if (triageByType) return triageByType.id;

  const triageByName = states.find((s) => s.name.toLowerCase() === "triage");
  if (triageByName) return triageByName.id;

  const backlog = states.find((s) => s.type === "backlog");
  return backlog?.id;
}

/**
 * Create an issue.
 *
 * For the full label resolution flow (finding/creating labels by name),
 * see the create-issue-with-labels scenario.
 */
const CREATE_ISSUE = `
  mutation CreateIssue($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue {
        id
        identifier
        url
      }
    }
  }
`;

async function createIssue(params: {
  teamId: string;
  title: string;
  description?: string;
  labelIds?: string[];
  stateId?: string;
}) {
  const result = await linearQuery<{
    issueCreate: {
      success: boolean;
      issue: { id: string; identifier: string; url: string };
    };
  }>(CREATE_ISSUE, {
    input: {
      teamId: params.teamId,
      title: params.title,
      description: params.description,
      labelIds: params.labelIds,
      stateId: params.stateId,
    },
  });

  return result.issueCreate.issue;
}

// =============================================================================
// 3. CREATE CUSTOMER REQUEST
// =============================================================================

/**
 * Attach a customer request to an issue.
 *
 * You can reference the customer by either:
 * - `customerId`: Linear's internal UUID
 * - `customerExternalId`: An ID from your external system (set via customerUpsert)
 *
 * Using `customerExternalId` avoids needing to track Linear customer UUIDs
 * in your external system.
 *
 * When `attachmentUrl` is provided, an attachment is created on the issue
 * linking back to the source record (e.g., a HubSpot ticket URL).
 */
const CREATE_CUSTOMER_NEED = `
  mutation CustomerNeedCreate($input: CustomerNeedCreateInput!) {
    customerNeedCreate(input: $input) {
      success
      need {
        id
      }
    }
  }
`;

interface CreateCustomerRequestParams {
  issueId: string;
  body?: string;
  customerId?: string;
  customerExternalId?: string;
  priority?: number;
  attachmentUrl?: string;
}

async function createCustomerRequest(params: CreateCustomerRequestParams) {
  const input: Record<string, unknown> = {
    issueId: params.issueId,
  };

  if (params.body) input.body = params.body;
  if (params.customerId) input.customerId = params.customerId;
  if (params.customerExternalId)
    input.customerExternalId = params.customerExternalId;
  if (params.priority !== undefined) input.priority = params.priority;
  if (params.attachmentUrl) input.attachmentUrl = params.attachmentUrl;

  const result = await linearQuery<{
    customerNeedCreate: {
      success: boolean;
      need: { id: string };
    };
  }>(CREATE_CUSTOMER_NEED, { input });

  return result.customerNeedCreate;
}

// =============================================================================
// EXAMPLE USAGE
// =============================================================================

/**
 * Full intake flow: create an issue from external data, upsert the customer,
 * and attach a customer request.
 *
 * This represents the additions to an existing intake workflow. If you're
 * already creating issues with labels, the new pieces are `upsertCustomer`
 * and `createCustomerRequest`.
 */
async function handleTicketFromHubSpot(ticket: {
  title: string;
  description: string;
  companyName: string;
  companyDomain: string;
  hubspotCompanyId: string;
  hubspotTicketId: string;
  labelIds: string[];
}) {
  const teamId = "<YOUR_TEAM_ID>";

  // 1. Upsert the customer (safe to run every time, even if customer exists)
  //    This can run in parallel with issue creation since they're independent.
  const [customer, triageStateId] = await Promise.all([
    upsertCustomer({
      name: ticket.companyName,
      domains: [ticket.companyDomain],
      externalId: `hubspot-${ticket.hubspotCompanyId}`,
    }),
    findTriageState(teamId),
  ]);

  // 2. Create the issue in Triage with labels
  //    Label resolution (find-or-create) should happen before this step.
  //    See the create-issue-with-labels scenario for that pattern.
  const issue = await createIssue({
    teamId,
    title: ticket.title,
    description: ticket.description,
    labelIds: ticket.labelIds,
    stateId: triageStateId,
  });

  // 3. Attach the customer request to the issue
  await createCustomerRequest({
    issueId: issue.id,
    customerExternalId: `hubspot-${ticket.hubspotCompanyId}`,
    body: ticket.description,
    attachmentUrl: `https://app.hubspot.com/contacts/YOUR_HUB_ID/ticket/${ticket.hubspotTicketId}`,
  });

  console.log(
    `Created ${issue.identifier} with customer request for ${customer.name}`
  );
  console.log(`Issue URL: ${issue.url}`);
}
