const crypto = require('crypto');
const logger = require('../utils/logger');
const linearService = require('../services/linear');
const customerSync = require('../services/customerSync');

/**
 * Timing-safe comparison of two strings
 * Prevents timing attacks on signature verification
 */
function timingSafeCompare(a, b) {
  try {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    
    if (bufA.length !== bufB.length) {
      crypto.timingSafeEqual(bufA, bufA);
      return false;
    }
    
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

/**
 * Verify Linear webhook signature
 * Linear uses HMAC-SHA256 for webhook signatures
 * The signature is sent in the 'linear-signature' header
 */
function verifyLinearSignature(rawBody, signature, timestamp, secret) {
  if (!signature || !secret) {
    return false;
  }

  // Try multiple signature formats - Linear's format may vary
  const formatsToTry = [
    rawBody,                           // Just body
    `${timestamp}.${rawBody}`,         // timestamp.body (if timestamp exists)
  ].filter(Boolean);

  for (const payload of formatsToTry) {
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(payload);
    const expectedSignature = hmac.digest('hex');

    if (timingSafeCompare(expectedSignature, signature)) {
      logger.debug('Signature matched with payload format:', payload === rawBody ? 'body only' : 'timestamp.body');
      return true;
    }
  }

  // Log debug info if no match
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(rawBody);
  const expectedSignature = hmac.digest('hex');
  logger.debug(`Expected (body only): ${expectedSignature.substring(0, 16)}...`);
  logger.debug(`Received:             ${signature.substring(0, 16)}...`);
  logger.debug(`Body length: ${rawBody.length}, Secret length: ${secret.length}`);

  return false;
}

/**
 * Handle Linear webhook
 * Linear webhooks typically contain action, type, and data fields
 */
async function handleLinearWebhook(req, res) {
  try {
    logger.info('Received webhook from Linear');

    // Check for webhook secret - support both env var names for flexibility
    const webhookSecret = process.env.LINEAR_WEBHOOK_SECRET || process.env.LINEAR_CLIENT_SECRET;

    // Verify signature if webhook secret is configured
    if (webhookSecret) {
      const signature = req.headers['linear-signature'];
      const timestamp = req.headers['linear-delivery'] || req.headers['linear-timestamp'];
      const rawBody = req.rawBody || JSON.stringify(req.body);

      // Log all linear-related headers for debugging
      const linearHeaders = Object.entries(req.headers)
        .filter(([key]) => key.toLowerCase().startsWith('linear') || key.toLowerCase().includes('signature'))
        .reduce((acc, [k, v]) => ({ ...acc, [k]: v }), {});
      logger.debug('Linear headers:', JSON.stringify(linearHeaders, null, 2));

      if (!signature) {
        logger.warn('No Linear signature header found in webhook request');
        return res.status(401).json({ error: 'Missing signature' });
      }

      if (!verifyLinearSignature(rawBody, signature, timestamp, webhookSecret)) {
        logger.error('Linear webhook signature verification failed');
        logger.debug('Try regenerating the webhook in Linear and updating LINEAR_WEBHOOK_SECRET');
        return res.status(401).json({ error: 'Invalid signature' });
      }

      logger.info('✓ Linear webhook signature verified successfully');
    } else {
      logger.debug('LINEAR_WEBHOOK_SECRET/LINEAR_CLIENT_SECRET not configured, skipping signature verification');
    }

    const payload = req.body;
    logger.debug('Linear webhook payload:', JSON.stringify(payload, null, 2));

    // Handle different webhook formats
    // Linear webhooks can come in different formats depending on the webhook type
    // Common structure: { action: 'create'|'update'|'remove', type: 'Customer', data: {...} }
    
    const action = payload.action;
    const webhookType = payload.type || payload.data?.__typename;

    logger.debug(`Webhook action: ${action}, type: ${webhookType}`);

    // Process customer-related webhooks
    if (webhookType === 'Customer' || payload.data?.__typename === 'Customer') {
      const customerData = payload.data || payload;
      const customerId = customerData?.id;

      if (!customerId) {
        logger.warn('Customer webhook received but no customer ID found in payload');
        return res.status(400).json({ error: 'Missing customer ID in webhook payload' });
      }

      if (action === 'create' || action === 'update') {
        logger.info(`Processing customer ${action} event: ${customerId}`);
        
        try {
          // Get full customer details from Linear
          // We fetch the full customer data to ensure we have all fields
          const customer = await linearService.getCustomer(customerId);

          if (!customer) {
            logger.warn(`Customer ${customerId} not found in Linear`);
            return res.status(404).json({ error: 'Customer not found' });
          }

          // Sync customer to HubSpot (only if bidirectional sync is enabled)
          await customerSync.syncLinearToHubSpot(customer);
        } catch (error) {
          logger.error(`Error processing customer ${action}:`, error.message);
          // Return 200 to acknowledge receipt even if processing failed
          // This prevents Linear from retrying the webhook
        }
      }
      else {
        logger.debug(`Skipping customer action: ${action}`);
      }
    } else {
      logger.debug(`Skipping webhook type: ${webhookType}`);
    }

    res.status(200).json({ status: 'success' });
  } catch (error) {
    logger.error('Error handling Linear webhook:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = handleLinearWebhook;

