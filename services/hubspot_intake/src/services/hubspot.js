const axios = require('axios');
const logger = require('../utils/logger');

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
}


module.exports = new HubSpotService();

