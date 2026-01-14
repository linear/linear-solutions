require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const hubspotWebhook = require('./webhooks/hubspot');
const linearWebhook = require('./webhooks/linear');
const linearService = require('./services/linear');
const logger = require('./utils/logger');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware - we need raw body for signature verification
app.use(express.json({
  limit: '10mb', // Increased to handle large webhook payloads
  verify: (req, res, buf) => {
    req.rawBody = buf.toString('utf8');
  }
}));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request ID middleware for debugging
app.use((req, res, next) => {
  req.requestId = crypto.randomUUID();
  res.setHeader('X-Request-ID', req.requestId);
  next();
});

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info(`${req.method} ${req.path} ${res.statusCode} ${duration}ms [${req.requestId}]`);
  });
  next();
});

// Root endpoint - for webhook verification/health checks
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'hubspot-linear-integration',
    message: 'Webhook endpoints are running. Use POST /webhooks/hubspot or POST /webhooks/linear for webhooks.'
  });
});

app.post('/', (req, res) => {
  logger.info('Received POST request to root endpoint (/)');
  logger.debug('Body:', JSON.stringify(req.body, null, 2));
  res.status(200).json({ 
    status: 'ok',
    message: 'Root endpoint received. Use POST /webhooks/hubspot or POST /webhooks/linear for webhooks.'
  });
});

// Health check endpoint
app.get('/health', async (req, res) => {
  const health = {
    status: 'ok',
    service: 'hubspot-linear-integration',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  };

  // Detailed health check if requested
  if (req.query.detailed === 'true') {
    health.checks = {};
    
    try {
      await linearService.getTeam();
      health.checks.linear = 'ok';
    } catch (error) {
      health.checks.linear = 'error';
      health.checks.linearError = error.message;
      health.status = 'degraded';
    }
  }

  const statusCode = health.status === 'ok' ? 200 : 503;
  res.status(statusCode).json(health);
});

// HubSpot webhook endpoint
app.post('/webhooks/hubspot', hubspotWebhook);

// Linear webhook endpoint
app.post('/webhooks/linear', linearWebhook);
// Alias for Linear webhook (alternative path)
app.post('/linear-webhook', linearWebhook);

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Validate configuration at startup
function validateConfiguration() {
  const ticketSyncEnabled = process.env.ENABLE_TICKET_SYNC !== 'false';
  const customerSyncEnabled = process.env.ENABLE_CUSTOMER_SYNC === 'true';
  const syncDirection = process.env.CUSTOMER_SYNC_DIRECTION || 'unidirectional';

  logger.info('Configuration:');
  logger.info(`  Ticket Sync: ${ticketSyncEnabled ? 'enabled' : 'disabled'}`);
  logger.info(`  Customer Sync: ${customerSyncEnabled ? 'enabled' : 'disabled'}`);
  
  if (customerSyncEnabled) {
    logger.info(`  Sync Direction: ${syncDirection}`);
    if (syncDirection !== 'bidirectional' && syncDirection !== 'unidirectional') {
      logger.warn(`  Warning: Invalid CUSTOMER_SYNC_DIRECTION value "${syncDirection}", defaulting to "unidirectional"`);
    }
  }

  // Warn if both are disabled
  if (!ticketSyncEnabled && !customerSyncEnabled) {
    logger.warn('Warning: Both ticket sync and customer sync are disabled. The integration will not process any events.');
  }
}

// Start server
validateConfiguration();

const server = app.listen(PORT, () => {
  logger.info(`Server is running on port ${PORT}`);
  logger.info(`HubSpot webhook endpoint: http://localhost:${PORT}/webhooks/hubspot`);
  logger.info(`Linear webhook endpoint: http://localhost:${PORT}/webhooks/linear (or /linear-webhook)`);
});

// Graceful shutdown handling
function gracefulShutdown(signal) {
  logger.info(`${signal} received, shutting down gracefully...`);
  
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });

  // Force shutdown after 10 seconds
  setTimeout(() => {
    logger.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

module.exports = app;

