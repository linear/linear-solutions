const axios = require('axios');
const logger = require('../utils/logger');
const config = require('../utils/config');

const HUBSPOT_API_URL = 'https://api.hubapi.com';

/**
 * HubSpot API client
 */
class HubSpotService {
  constructor() {
    this.accessToken = process.env.HUBSPOT_ACCESS_TOKEN;
    
    if (!this.accessToken) {
      throw new Error('HUBSPOT_ACCESS_TOKEN is not set');
    }
  }

  /**
   * Get ticket details from HubSpot
   */
  async getTicket(ticketId) {
    try {
      const response = await axios.get(
        `${HUBSPOT_API_URL}/crm/v3/objects/tickets/${ticketId}`,
        {
          params: {
            properties: [
              'subject',
              'content',
              'hs_ticket_id',
              'hs_ticket_priority',
              'hs_ticket_category',
              'hs_ticket_status',
              'hs_pipeline',
              'hs_pipeline_stage',
              'source_type',
              'createdate'
            ].join(',')
          },
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return response.data.properties;
    } catch (error) {
      logger.error(`Failed to get ticket ${ticketId}:`, error.message);
      throw error;
    }
  }

  /**
   * Update ticket in HubSpot
   */
  async updateTicket(ticketId, properties) {
    try {
      const response = await axios.patch(
        `${HUBSPOT_API_URL}/crm/v3/objects/tickets/${ticketId}`,
        {
          properties
        },
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return response.data;
    } catch (error) {
      logger.error(`Failed to update ticket ${ticketId}:`, error.message);
      if (error.response?.data) {
        logger.error('Error details:', JSON.stringify(error.response.data, null, 2));
      }
      throw error;
    }
  }

  /**
   * Add a note/comment to a HubSpot ticket
   */
  async addNoteToTicket(ticketId, noteContent) {
    try {
      // First, create the note engagement
      const createResponse = await axios.post(
        `${HUBSPOT_API_URL}/crm/v3/objects/notes`,
        {
          properties: {
            hs_note_body: noteContent,
            hs_timestamp: Date.now().toString()
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      const noteId = createResponse.data.id;
      logger.debug(`Created note ${noteId}, associating with ticket ${ticketId}`);

      // Then, associate the note with the ticket
      await axios.put(
        `${HUBSPOT_API_URL}/crm/v3/objects/notes/${noteId}/associations/tickets/${ticketId}/note_to_ticket`,
        {},
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      logger.debug(`Associated note ${noteId} with ticket ${ticketId}`);
      return createResponse.data;
    } catch (error) {
      logger.error(`Failed to add note to ticket ${ticketId}:`, error.message);
      if (error.response?.data) {
        logger.error('Error details:', JSON.stringify(error.response.data, null, 2));
      }
      throw error;
    }
  }

  /**
   * Get the HubSpot ticket URL
   */
  getTicketUrl(ticketId, portalId) {
    return `https://app.hubspot.com/contacts/${portalId}/ticket/${ticketId}`;
  }

  /**
   * Get owner email by owner ID
   * Used for mapping HubSpot owners to Linear users
   */
  async getOwnerEmail(ownerId) {
    try {
      const response = await axios.get(
        `${HUBSPOT_API_URL}/crm/v3/owners/${ownerId}`,
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
      return response.data.email;
    } catch (error) {
      logger.error(`Failed to get owner ${ownerId}:`, error.message);
      return null;
    }
  }

  /**
   * Get owner ID by email
   * Used for mapping Linear users to HubSpot owners
   */
  async getOwnerByEmail(email) {
    try {
      const response = await axios.get(
        `${HUBSPOT_API_URL}/crm/v3/owners`,
        {
          params: {
            email: email,
            limit: 1
          },
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      const owner = response.data.results?.[0];
      if (owner) {
        logger.debug(`Found HubSpot owner for ${email}: ${owner.id}`);
        return owner.id;
      }
      return null;
    } catch (error) {
      logger.error(`Failed to find owner by email ${email}:`, error.message);
      return null;
    }
  }

  /**
   * Get company details from HubSpot
   * Fetches all properties needed for Linear customer sync (configured in field-mappings.json)
   */
  async getCompany(companyId) {
    try {
      // Get configurable field list from config
      const fieldsToFetch = config.getHubSpotFieldsToFetch();
      
      logger.debug(`Fetching company ${companyId} with properties: ${fieldsToFetch.join(', ')}`);
      
      const response = await axios.get(
        `${HUBSPOT_API_URL}/crm/v3/objects/companies/${companyId}`,
        {
          params: {
            properties: fieldsToFetch.join(',')
          },
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      logger.debug(`HubSpot returned properties: ${Object.keys(response.data.properties).join(', ')}`);

      return {
        id: response.data.id,
        properties: response.data.properties
      };
    } catch (error) {
      logger.error(`Failed to get company ${companyId}:`, error.message);
      throw error;
    }
  }

  /**
   * Get all companies from HubSpot (with pagination)
   */
  async getCompanies(limit = 100, after = null) {
    try {
      const params = {
        properties: ['name', 'domain', 'website'],
        limit: limit
      };

      if (after) {
        params.after = after;
      }

      const response = await axios.get(
        `${HUBSPOT_API_URL}/crm/v3/objects/companies`,
        {
          params,
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return {
        results: response.data.results,
        paging: response.data.paging
      };
    } catch (error) {
      logger.error('Failed to get companies:', error.message);
      throw error;
    }
  }

  /**
   * Create a company in HubSpot
   */
  async createCompany(properties) {
    try {
      const response = await axios.post(
        `${HUBSPOT_API_URL}/crm/v3/objects/companies`,
        {
          properties
        },
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      logger.info(`Created HubSpot company: ${response.data.id}`);
      return {
        id: response.data.id,
        properties: response.data.properties
      };
    } catch (error) {
      logger.error('Failed to create company:', error.message);
      if (error.response?.data) {
        logger.error('Error details:', JSON.stringify(error.response.data, null, 2));
      }
      throw error;
    }
  }

  /**
   * Update company in HubSpot
   */
  async updateCompany(companyId, properties) {
    try {
      const response = await axios.patch(
        `${HUBSPOT_API_URL}/crm/v3/objects/companies/${companyId}`,
        {
          properties
        },
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      logger.info(`Updated HubSpot company: ${companyId}`);
      return response.data;
    } catch (error) {
      logger.error(`Failed to update company ${companyId}:`, error.message);
      if (error.response?.data) {
        logger.error('Error details:', JSON.stringify(error.response.data, null, 2));
      }
      throw error;
    }
  }

  /**
   * Search for a company by name in HubSpot using the native search API
   * Returns the first matching company or null if not found
   */
  async searchCompanyByName(name) {
    try {
      const searchName = name.trim();
      
      const response = await axios.post(
        `${HUBSPOT_API_URL}/crm/v3/objects/companies/search`,
        {
          filterGroups: [{
            filters: [{
              propertyName: 'name',
              operator: 'EQ',
              value: searchName
            }]
          }],
          properties: config.getHubSpotFieldsToFetch(),
          limit: 1
        },
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      const result = response.data.results[0] || null;
      
      if (result) {
        logger.debug(`Found HubSpot company by name "${searchName}": ${result.id}`);
      } else {
        logger.debug(`No HubSpot company found with name "${searchName}"`);
      }

      return result;
    } catch (error) {
      logger.error(`Failed to search for company by name "${name}":`, error.message);
      if (error.response?.data) {
        logger.error('Error details:', JSON.stringify(error.response.data, null, 2));
      }
      throw error;
    }
  }
}


module.exports = new HubSpotService();

