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
        throw new Error(`Linear API error: ${JSON.stringify(response.data.errors)}`);
      }

      return response.data.data;
    } catch (error) {
      logger.error('Linear API request failed:', error.message);
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
}

module.exports = new LinearService();

