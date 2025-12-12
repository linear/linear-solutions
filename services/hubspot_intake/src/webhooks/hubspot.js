const crypto = require('crypto');
const logger = require('../utils/logger');
const linearService = require('../services/linear');
const hubspotService = require('../services/hubspot');

/**
 * Verify HubSpot webhook signature v1 (simpler, more reliable)
 * v1 signature = sha256(clientSecret + requestBody)
 * Result is hex encoded
 */
function verifySignatureV1(requestBody, signature, clientSecret) {
  const sourceString = clientSecret + requestBody;
  
  const hash = crypto
    .createHash('sha256')
    .update(sourceString)
    .digest('hex');
  
  return hash === signature;
}

/**
 * Verify HubSpot webhook signature v3
 * v3 signature = sha256(clientSecret + httpMethod + uri + requestBody)
 * Result is base64 encoded
 */
function verifySignatureV3(requestBody, signature, clientSecret, method, uri) {
  const sourceString = clientSecret + method + uri + requestBody;
  
  const hash = crypto
    .createHash('sha256')
    .update(sourceString)
    .digest('base64');
  
  return hash === signature;
}

/**
 * Check if ticket matches filter criteria
 */
function shouldProcessTicket(ticket) {
  // Customize these filters based on your needs
  const filters = {
    // Filter by pipeline if specified
    pipeline: process.env.HUBSPOT_PIPELINE_ID,
    
    // Filter by status if specified
    status: process.env.HUBSPOT_TICKET_STATUS,
    
    // Filter by priority if specified
    priority: process.env.HUBSPOT_TICKET_PRIORITY,
    
    // Filter by category if specified
    category: process.env.HUBSPOT_TICKET_CATEGORY
  };

  // If no filters are set, process all tickets
  const hasFilters = Object.values(filters).some(filter => filter);
  if (!hasFilters) {
    return true;
  }

  // Check each filter
  if (filters.pipeline && ticket.pipeline !== filters.pipeline) {
    return false;
  }

  if (filters.status && ticket.hs_ticket_status !== filters.status) {
    return false;
  }

  if (filters.priority && ticket.hs_ticket_priority !== filters.priority) {
    return false;
  }

  if (filters.category && ticket.hs_ticket_category !== filters.category) {
    return false;
  }

  return true;
}

/**
 * Handle HubSpot webhook
 */
async function handleHubSpotWebhook(req, res) {
  try {
    logger.info('Received webhook from HubSpot');

    // Verify signature if client secret is configured
    if (process.env.HUBSPOT_CLIENT_SECRET) {
      const signatureV3 = req.headers['x-hubspot-signature-v3'];
      const signatureV2 = req.headers['x-hubspot-signature-v2'];
      const signatureV1 = req.headers['x-hubspot-signature'];
      const signatureVersion = req.headers['x-hubspot-signature-version'];
      const requestBody = req.rawBody || JSON.stringify(req.body);
      
      logger.debug('Signature headers present:', {
        v3: !!signatureV3,
        v2: !!signatureV2,
        v1: !!signatureV1,
        version: signatureVersion
      });
      
      if (!signatureV3 && !signatureV2 && !signatureV1) {
        logger.warn('No signature header found in webhook request');
        logger.warn('Available headers:', Object.keys(req.headers));
        return res.status(401).json({ error: 'Missing signature' });
      }
      
      // Try v1 signature first (simpler and more reliable)
      if (signatureV1) {
        logger.debug('Attempting v1 signature verification');
        logger.debug('  V1 signature:', signatureV1);
        logger.debug('  Body length:', requestBody.length);
        
        if (verifySignatureV1(requestBody, signatureV1, process.env.HUBSPOT_CLIENT_SECRET)) {
          logger.info('✓ Webhook signature verified successfully (v1)');
        } else {
          logger.error('V1 signature verification failed');
          const expectedHash = crypto.createHash('sha256')
            .update(process.env.HUBSPOT_CLIENT_SECRET + requestBody)
            .digest('hex');
          logger.debug('  Expected:', expectedHash);
          logger.debug('  Received:', signatureV1);
          return res.status(401).json({ error: 'Invalid signature' });
        }
      }
      // Fall back to v3 if no v1 present
      else if (signatureV3) {
        const method = req.method.toUpperCase();
        const uri = `https://${req.get('host')}${req.originalUrl}`;
        const timestamp = req.headers['x-hubspot-request-timestamp'];
        const sourceString = process.env.HUBSPOT_CLIENT_SECRET + method + uri + requestBody;
        
        logger.debug('V3 Signature verification details:');
        logger.debug('  Method:', method);
        logger.debug('  URI:', uri);
        logger.debug('  Timestamp header:', timestamp);
        logger.debug('  Body length:', requestBody.length);
        logger.debug('  Body preview:', requestBody.substring(0, 100));
        logger.debug('  Body (full):', requestBody);
        logger.debug('  Client secret length:', process.env.HUBSPOT_CLIENT_SECRET.length);
        logger.debug('  Client secret preview:', process.env.HUBSPOT_CLIENT_SECRET.substring(0, 10) + '...');
        logger.debug('  Source string length:', sourceString.length);
        logger.debug('  Expected signature:', signatureV3);
        logger.debug('  All headers:', JSON.stringify(req.headers, null, 2));
        
        if (!verifySignatureV3(requestBody, signatureV3, process.env.HUBSPOT_CLIENT_SECRET, method, uri)) {
          logger.error('V3 signature verification failed');
          
          // Try different variations including with/without timestamp
          const variations = [
            { name: 'Standard (https://)', source: process.env.HUBSPOT_CLIENT_SECRET + method + uri + requestBody },
            { name: 'With timestamp at end', source: process.env.HUBSPOT_CLIENT_SECRET + method + uri + requestBody + timestamp },
            { name: 'With timestamp before body', source: process.env.HUBSPOT_CLIENT_SECRET + method + uri + timestamp + requestBody },
            { name: 'No protocol', source: process.env.HUBSPOT_CLIENT_SECRET + method + `${req.get('host')}${req.originalUrl}` + requestBody },
            { name: 'HTTP protocol', source: process.env.HUBSPOT_CLIENT_SECRET + method + `http://${req.get('host')}${req.originalUrl}` + requestBody },
          ];
          
          logger.debug('\nTrying different variations:');
          for (const variation of variations) {
            const hash = crypto.createHash('sha256').update(variation.source).digest('base64');
            logger.debug(`  ${variation.name}: ${hash}`);
            if (hash === signatureV3) {
              logger.info(`  ✓✓✓ MATCH FOUND with: ${variation.name} ✓✓✓`);
            }
          }
          
          logger.debug('\nExpected hash:', signatureV3);
          
          return res.status(401).json({ error: 'Invalid signature' });
        }
      } else {
        logger.warn('Only v3 signatures are supported. Found v2 or v1 signature.');
        return res.status(401).json({ error: 'Unsupported signature version' });
      }
      
      logger.info('Webhook signature verified successfully');
    }

    // Process each event in the webhook
    const events = req.body;
    logger.debug('Webhook payload:', JSON.stringify(events, null, 2));

    for (const event of events) {
      // Only process ticket creation events
      if (event.subscriptionType === 'ticket.creation') {
        logger.info(`Processing ticket creation event: ${event.objectId}`);

        try {
          // Fetch full ticket details from HubSpot
          const ticket = await hubspotService.getTicket(event.objectId);
          
          logger.info(`Ticket details: ${ticket.subject || 'No subject'}`);

          // Check if ticket matches filter criteria
          if (!shouldProcessTicket(ticket)) {
            logger.info(`Ticket ${event.objectId} does not match filter criteria, skipping`);
            continue;
          }

          // Create ticket in Linear
          const linearIssue = await linearService.createIssue({
            title: ticket.subject || 'Untitled HubSpot Ticket',
            description: formatTicketDescription(ticket),
            priority: mapPriority(ticket.hs_ticket_priority),
            hubspotTicketId: ticket.hs_ticket_id || event.objectId
          });

          logger.info(`Created Linear issue: ${linearIssue.id} (${linearIssue.identifier}) for HubSpot ticket: ${event.objectId}`);

          // Add HubSpot ticket link as attachment to Linear issue
          const hubspotTicketUrl = hubspotService.getTicketUrl(event.objectId, event.portalId);
          try {
            await linearService.addAttachmentToIssue(
              linearIssue.id,
              hubspotTicketUrl,
              'HubSpot Ticket'
            );
            logger.info(`Added HubSpot ticket link to Linear issue`);
          } catch (error) {
            logger.error(`Failed to add HubSpot link to Linear issue:`, error.message);
            // Continue even if attachment fails
          }

          // Optionally, add a note to HubSpot ticket with Linear issue link
          if (process.env.UPDATE_HUBSPOT_WITH_LINEAR_LINK === 'true' && linearIssue.url) {
            try {
              await hubspotService.addNoteToTicket(
                event.objectId,
                `Linear issue created: ${linearIssue.identifier} \n\n${linearIssue.url}`
              );
              logger.info(`Added note to HubSpot ticket with Linear issue link`);
            } catch (error) {
              logger.error(`Failed to add note to HubSpot ticket:`, error.message);
              // Continue even if note fails
            }
          }

        } catch (error) {
          logger.error(`Error processing ticket ${event.objectId}:`, error.message);
          // Continue processing other events even if one fails
        }
      } else {
        logger.debug(`Skipping event type: ${event.subscriptionType}`);
      }
    }

    res.status(200).json({ status: 'success' });
  } catch (error) {
    logger.error('Error handling webhook:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Format ticket description for Linear
 */
function formatTicketDescription(ticket) {
  let description = '';

  if (ticket.content) {
    description += `${ticket.content}\n\n`;
  }

  description += `---\n\n`;
  description += `**HubSpot Ticket Details**\n\n`;
  description += `- Ticket ID: ${ticket.hs_ticket_id || 'N/A'}\n`;
  
  if (ticket.hs_ticket_priority) {
    description += `- Priority: ${ticket.hs_ticket_priority}\n`;
  }
  
  if (ticket.hs_ticket_category) {
    description += `- Category: ${ticket.hs_ticket_category}\n`;
  }
  
  if (ticket.source_type) {
    description += `- Source: ${ticket.source_type}\n`;
  }

  if (ticket.createdate) {
    description += `- Created: ${new Date(ticket.createdate).toLocaleString()}\n`;
  }

  return description;
}

/**
 * Map HubSpot priority to Linear priority
 * HubSpot: none, LOW, MEDIUM, HIGH, URGENT
 * Linear: 0 = none, 4 = low, 3 = medium, 2 = high, 1 = urgent
 */
function mapPriority(hubspotPriority) {
  if (!hubspotPriority) {
    return 0; // No priority
  }

  const priorityMap = {
    'LOW': 4,       // Low
    'MEDIUM': 3,    // Medium
    'HIGH': 2,      // High
    'URGENT': 1     // Urgent
  };

  return priorityMap[hubspotPriority.toUpperCase()] || 0;
}

module.exports = handleHubSpotWebhook;

