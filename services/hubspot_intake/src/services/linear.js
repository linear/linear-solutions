const axios = require('axios');
const logger = require('../utils/logger');

const LINEAR_API_URL = 'https://api.linear.app/graphql';

/**
 * Linear API client
 */
class LinearService {
  constructor() {
    this.apiKey = process.env.LINEAR_API_KEY;
    this.teamIdOrKey = process.env.LINEAR_TEAM_ID;
    this.teamId = null; // Will be resolved to UUID
    this.teamIdResolved = false;
    
    if (!this.apiKey) {
      throw new Error('LINEAR_API_KEY is not set');
    }
    
    if (!this.teamIdOrKey) {
      throw new Error('LINEAR_TEAM_ID is not set');
    }
  }

  /**
   * Check if a string is a UUID
   */
  isUuid(str) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuidRegex.test(str);
  }

  /**
   * Resolve team ID - convert team key to UUID if needed
   */
  async resolveTeamId() {
    if (this.teamIdResolved) {
      return this.teamId;
    }

    // If it's already a UUID, use it directly
    if (this.isUuid(this.teamIdOrKey)) {
      logger.info(`Using team UUID: ${this.teamIdOrKey}`);
      this.teamId = this.teamIdOrKey;
      this.teamIdResolved = true;
      return this.teamId;
    }

    // Otherwise, treat it as a team key and look it up
    logger.info(`Looking up team by key: ${this.teamIdOrKey}`);
    
    const query = `
      query GetTeams {
        teams {
          nodes {
            id
            name
            key
          }
        }
      }
    `;

    const data = await this.makeRequest(query);
    const teams = data.teams.nodes;
    
    const team = teams.find(t => t.key === this.teamIdOrKey || t.key.toLowerCase() === this.teamIdOrKey.toLowerCase());
    
    if (!team) {
      const availableKeys = teams.map(t => t.key).join(', ');
      throw new Error(
        `Team with key "${this.teamIdOrKey}" not found. Available teams: ${availableKeys}`
      );
    }

    logger.info(`Found team: ${team.name} (${team.key}) - UUID: ${team.id}`);
    this.teamId = team.id;
    this.teamIdResolved = true;
    return this.teamId;
  }

  /**
   * Make a GraphQL request to Linear API
   */
  async makeRequest(query, variables = {}) {
    try {
      const response = await axios.post(
        LINEAR_API_URL,
        {
          query,
          variables
        },
        {
          headers: {
            'Authorization': this.apiKey,
            'Content-Type': 'application/json'
          }
        }
      );

      if (response.data.errors) {
        logger.error('Linear GraphQL errors:', JSON.stringify(response.data.errors, null, 2));
        throw new Error(`Linear API error: ${response.data.errors[0]?.message || 'Unknown error'}`);
      }

      return response.data.data;
    } catch (error) {
      logger.error('Linear API request failed:', error.message);
      if (error.response?.data) {
        logger.error('Linear API response:', JSON.stringify(error.response.data, null, 2));
      }
      throw error;
    }
  }

  /**
   * Get the triage state ID for the team
   */
  async getTriageStateId() {
    await this.resolveTeamId();
    
    const query = `
      query GetTeamStates($teamId: String!) {
        team(id: $teamId) {
          states {
            nodes {
              id
              name
              type
            }
          }
        }
      }
    `;

    const data = await this.makeRequest(query, { teamId: this.teamId });
    const states = data.team.states.nodes;
    
    // Find the triage state (usually "Triage" or "Backlog")
    const triageState = states.find(
      state => state.type === 'triage' || state.name.toLowerCase() === 'triage'
    );

    if (!triageState) {
      // Fall back to the first backlog state
      const backlogState = states.find(state => state.type === 'backlog');
      if (backlogState) {
        logger.warn('No triage state found, using backlog state');
        return backlogState.id;
      }
      
      throw new Error('No triage or backlog state found for team');
    }

    return triageState.id;
  }

  /**
   * Create an issue in Linear
   */
  async createIssue({ title, description, priority, hubspotTicketId }) {
    logger.info(`Creating Linear issue: ${title}`);

    // Ensure team ID is resolved
    await this.resolveTeamId();

    // Get the triage state ID
    const stateId = await this.getTriageStateId();

    const mutation = `
      mutation CreateIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue {
            id
            identifier
            title
            url
          }
        }
      }
    `;

    const variables = {
      input: {
        teamId: this.teamId,
        title: title,
        description: description,
        stateId: stateId,
        priority: priority || 0
      }
    };

    // Add labels if configured
    if (process.env.LINEAR_LABEL_IDS) {
      const labelIds = process.env.LINEAR_LABEL_IDS.split(',').map(id => id.trim());
      variables.input.labelIds = labelIds;
    }

    const data = await this.makeRequest(mutation, variables);

    if (!data.issueCreate.success) {
      throw new Error('Failed to create Linear issue');
    }

    const issue = data.issueCreate.issue;
    logger.info(`Created Linear issue ${issue.identifier}: ${issue.url}`);

    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      url: issue.url
    };
  }

  /**
   * Add an attachment/link to a Linear issue
   */
  async addAttachmentToIssue(issueId, url, title) {
    logger.info(`Adding attachment to Linear issue ${issueId}: ${url}`);

    const mutation = `
      mutation CreateAttachment($input: AttachmentCreateInput!) {
        attachmentCreate(input: $input) {
          success
          attachment {
            id
            title
            url
          }
        }
      }
    `;

    const variables = {
      input: {
        issueId: issueId,
        url: url,
        title: title || 'Related Link'
      }
    };

    const data = await this.makeRequest(mutation, variables);

    if (!data.attachmentCreate.success) {
      throw new Error('Failed to create Linear attachment');
    }

    logger.info(`Added attachment to Linear issue: ${data.attachmentCreate.attachment.id}`);
    return data.attachmentCreate.attachment;
  }

  /**
   * Get team information
   */
  async getTeam() {
    await this.resolveTeamId();
    
    const query = `
      query GetTeam($teamId: String!) {
        team(id: $teamId) {
          id
          name
          key
        }
      }
    `;

    const data = await this.makeRequest(query, { teamId: this.teamId });
    return data.team;
  }

  /**
   * Get customer by ID from Linear
   * Fetches all available customer properties
   */
  async getCustomer(customerId) {
    try {
      const query = `
        query GetCustomer($customerId: String!) {
          customer(id: $customerId) {
            id
            name
            domains
            logoUrl
            owner {
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
            revenue
            size
            createdAt
            updatedAt
          }
        }
      `;

      const data = await this.makeRequest(query, { customerId });
      return data.customer;
    } catch (error) {
      logger.error(`Failed to get customer ${customerId}:`, error.message);
      throw error;
    }
  }

  /**
   * Get all customers from Linear
   * Fetches all available customer properties
   */
  async getCustomers(limit = 50, after = null) {
    try {
      const query = `
        query GetCustomers($after: String, $first: Int) {
          customers(after: $after, first: $first) {
            nodes {
              id
              name
              domains
              logoUrl
              owner {
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
              revenue
              size
              createdAt
              updatedAt
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `;

      const variables = {
        first: limit
      };

      if (after) {
        variables.after = after;
      }

      const data = await this.makeRequest(query, variables);
      return {
        nodes: data.customers.nodes,
        pageInfo: data.customers.pageInfo
      };
    } catch (error) {
      logger.error('Failed to get customers:', error.message);
      throw error;
    }
  }

  /**
   * Create a customer in Linear
   * Supports customer properties: name, domains, logoUrl, ownerId, statusId, tierId, revenue, size (number)
   */
  async createCustomer(input) {
    try {
      // Ensure we only send valid fields that Linear expects
      const cleanInput = {};
      if (input.name) cleanInput.name = input.name;
      if (input.domains && input.domains.length > 0) cleanInput.domains = input.domains;
      // logoUrl must be from https://public.linear.app domain
      if (input.logoUrl && input.logoUrl.includes('public.linear.app')) {
        cleanInput.logoUrl = input.logoUrl;
      }
      if (input.ownerId) cleanInput.ownerId = input.ownerId;
      if (input.statusId) cleanInput.statusId = input.statusId;
      if (input.tierId) cleanInput.tierId = input.tierId;
      if (input.revenue !== undefined && input.revenue !== null) cleanInput.revenue = input.revenue;
      // size is a number (employee count), not sizeId
      if (input.size !== undefined && input.size !== null) cleanInput.size = input.size;

      logger.debug('Creating customer with input:', JSON.stringify(cleanInput, null, 2));

      const mutation = `
        mutation CreateCustomer($input: CustomerCreateInput!) {
          customerCreate(input: $input) {
            success
            customer {
              id
              name
            }
          }
        }
      `;

      const variables = {
        input: cleanInput
      };

      const data = await this.makeRequest(mutation, variables);

      if (!data.customerCreate.success) {
        throw new Error('Failed to create Linear customer');
      }

      logger.info(`Created Linear customer: ${data.customerCreate.customer.id} (${data.customerCreate.customer.name})`);
      return data.customerCreate.customer;
    } catch (error) {
      logger.error('Failed to create customer:', error.message);
      throw error;
    }
  }

  /**
   * Update a customer in Linear
   * Supports customer properties: name, domains, logoUrl, ownerId, statusId, tierId, revenue, size (number)
   */
  async updateCustomer(customerId, input) {
    try {
      // Clean the input - ensure size is a number, not sizeId
      const cleanInput = { ...input };
      if (cleanInput.sizeId) {
        delete cleanInput.sizeId; // Remove incorrect field
      }

      const mutation = `
        mutation UpdateCustomer($id: String!, $input: CustomerUpdateInput!) {
          customerUpdate(id: $id, input: $input) {
            success
            customer {
              id
              name
              domains
              logoUrl
              owner {
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
              revenue
              size
              updatedAt
            }
          }
        }
      `;

      const variables = {
        id: customerId,
        input: cleanInput
      };

      const data = await this.makeRequest(mutation, variables);

      if (!data.customerUpdate.success) {
        throw new Error('Failed to update Linear customer');
      }

      logger.info(`Updated Linear customer: ${customerId}`);
      return data.customerUpdate.customer;
    } catch (error) {
      logger.error(`Failed to update customer ${customerId}:`, error.message);
      throw error;
    }
  }

  /**
   * Get all customer statuses from Linear
   * Used for mapping HubSpot lead status to Linear customer status
   */
  async getCustomerStatuses() {
    try {
      const query = `
        query GetCustomerStatuses {
          customerStatuses {
            nodes {
              id
              name
              displayName
              type
            }
          }
        }
      `;

      const data = await this.makeRequest(query);
      return data.customerStatuses.nodes;
    } catch (error) {
      logger.error('Failed to get customer statuses:', error.message);
      return [];
    }
  }

  /**
   * Get all customer tiers from Linear
   * Used for mapping HubSpot ideal customer profile to Linear customer tier
   */
  async getCustomerTiers() {
    try {
      const query = `
        query GetCustomerTiers {
          customerTiers {
            nodes {
              id
              name
              displayName
            }
          }
        }
      `;

      const data = await this.makeRequest(query);
      return data.customerTiers.nodes;
    } catch (error) {
      logger.error('Failed to get customer tiers:', error.message);
      return [];
    }
  }

  /**
   * Get all customer sizes from Linear
   * Used for mapping HubSpot employee range to Linear customer size
   */
  async getCustomerSizes() {
    try {
      const query = `
        query GetCustomerSizes {
          customerSizes {
            nodes {
              id
              name
            }
          }
        }
      `;

      const data = await this.makeRequest(query);
      return data.customerSizes.nodes;
    } catch (error) {
      logger.error('Failed to get customer sizes:', error.message);
      return [];
    }
  }

  /**
   * Get all users from Linear
   * Used for mapping HubSpot owner to Linear customer owner
   */
  async getUsers() {
    try {
      const query = `
        query GetUsers {
          users {
            nodes {
              id
              name
              email
              active
            }
          }
        }
      `;

      const data = await this.makeRequest(query);
      return data.users.nodes;
    } catch (error) {
      logger.error('Failed to get users:', error.message);
      return [];
    }
  }

  /**
   * Search for a customer by name in Linear
   * Returns the first matching customer or null if not found
   */
  async searchCustomerByName(name) {
    try {
      // Normalize name for search
      const normalizedName = name.trim().toLowerCase();

      // Get customers and search through them
      let after = null;
      let found = null;

      do {
        const result = await this.getCustomers(50, after);
        
        for (const customer of result.nodes) {
          const customerName = (customer.name || '').trim().toLowerCase();
          if (customerName === normalizedName) {
            found = customer;
            break;
          }
        }

        after = result.pageInfo?.hasNextPage ? result.pageInfo.endCursor : null;
      } while (!found && after);

      return found;
    } catch (error) {
      logger.error(`Failed to search for customer by name "${name}":`, error.message);
      throw error;
    }
  }

  /**
   * Search for a customer by domain in Linear
   * Returns the first matching customer or null if not found
   * This is useful when company names change but domains stay the same
   */
  async searchCustomerByDomain(domain) {
    try {
      // Normalize domain - remove www. prefix and lowercase
      const normalizedDomain = domain.trim().toLowerCase().replace(/^www\./, '');

      // Get customers and search through their domains
      let after = null;
      let found = null;

      do {
        const result = await this.getCustomers(50, after);
        
        for (const customer of result.nodes) {
          if (customer.domains && customer.domains.length > 0) {
            // Check if any of the customer's domains match
            const hasMatchingDomain = customer.domains.some(d => {
              const customerDomain = (d || '').trim().toLowerCase().replace(/^www\./, '');
              return customerDomain === normalizedDomain;
            });
            
            if (hasMatchingDomain) {
              found = customer;
              break;
            }
          }
        }

        after = result.pageInfo?.hasNextPage ? result.pageInfo.endCursor : null;
      } while (!found && after);

      if (found) {
        logger.debug(`Found customer by domain "${domain}": ${found.name}`);
      }
      return found;
    } catch (error) {
      logger.error(`Failed to search for customer by domain "${domain}":`, error.message);
      throw error;
    }
  }
}

module.exports = new LinearService();

