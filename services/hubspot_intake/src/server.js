require('dotenv').config();
const express = require('express');
const hubspotWebhook = require('./webhooks/hubspot');
const logger = require('./utils/logger');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware - we need raw body for signature verification
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString('utf8');
  }
}));
app.use(express.urlencoded({ extended: true }));

// Root endpoint - for webhook verification/health checks
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'hubspot-linear-integration',
    message: 'Webhook endpoint is running. Use POST /webhooks/hubspot for webhooks.'
  });
});

app.post('/', (req, res) => {
  logger.info('Received POST request to root endpoint (/) - redirecting to /webhooks/hubspot');
  logger.debug('Body:', JSON.stringify(req.body, null, 2));
  res.status(200).json({ 
    status: 'ok',
    message: 'Root endpoint received. Use POST /webhooks/hubspot for webhooks.'
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'hubspot-linear-integration' });
});

// HubSpot webhook endpoint
app.post('/webhooks/hubspot', hubspotWebhook);

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
  logger.info(`Server is running on port ${PORT}`);
  logger.info(`Webhook endpoint: http://localhost:${PORT}/webhooks/hubspot`);
});

module.exports = app;

