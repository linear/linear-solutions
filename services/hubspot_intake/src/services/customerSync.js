const logger = require('../utils/logger');
const config = require('../utils/config');
const hubspotService = require('./hubspot');
const linearService = require('./linear');

/**
 * Sync lock to prevent infinite loops in bidirectional sync
 * When syncing HubSpot → Linear triggers a Linear webhook → HubSpot sync
 */
const syncInProgress = new Map();
const SYNC_LOCK_TIMEOUT_MS = 10000; // 10 seconds

/**
 * Cache for Linear attribute options (statuses, tiers, users)
 * Note: size is a plain number (employee count), not a separate attribute type
 * Refreshed periodically to avoid stale data
 */
let attributeCache = {
  statuses: null,
  tiers: null,
  users: null,
  lastFetch: 0
};
const CACHE_TTL_MS = 300000; // 5 minutes

/**
 * Check if a sync is already in progress for this entity
 */
function isSyncLocked(lockKey) {
  const lockTime = syncInProgress.get(lockKey);
  if (!lockTime) return false;
  
  // Check if lock has expired
  if (Date.now() - lockTime > SYNC_LOCK_TIMEOUT_MS) {
    syncInProgress.delete(lockKey);
    return false;
  }
  
  return true;
}

/**
 * Set a sync lock for this entity
 */
function setSyncLock(lockKey) {
  syncInProgress.set(lockKey, Date.now());
}

/**
 * Clear a sync lock
 */
function clearSyncLock(lockKey) {
  syncInProgress.delete(lockKey);
}

/**
 * Normalize a name for comparison (trim, lowercase)
 */
function normalizeName(name) {
  if (!name) return '';
  return name.trim().toLowerCase();
}

/**
 * Check if customer syncing is enabled and should proceed
 */
function shouldSyncCustomer() {
  const enabled = process.env.ENABLE_CUSTOMER_SYNC === 'true';
  if (!enabled) {
    return false;
  }
  return true;
}

/**
 * Check if bidirectional sync is enabled
 */
function isBidirectionalSync() {
  return process.env.CUSTOMER_SYNC_DIRECTION === 'bidirectional';
}

/**
 * Load Linear attribute options (statuses, tiers, users) with caching
 * Note: size is a plain number (employee count), not a separate attribute type
 * These features may not be available in all Linear workspaces
 */
async function loadLinearAttributes() {
  const now = Date.now();
  
  // Return cached data if still fresh
  if (attributeCache.lastFetch && (now - attributeCache.lastFetch < CACHE_TTL_MS)) {
    return attributeCache;
  }

  logger.debug('Loading Linear customer attributes...');

  // Load each attribute type independently to handle partial failures
  // Some features may not be available in all Linear workspaces
  const results = await Promise.allSettled([
    linearService.getCustomerStatuses(),
    linearService.getCustomerTiers(),
    linearService.getUsers()
  ]);

  attributeCache = {
    statuses: results[0].status === 'fulfilled' ? (results[0].value || []) : [],
    tiers: results[1].status === 'fulfilled' ? (results[1].value || []) : [],
    users: results[2].status === 'fulfilled' ? (results[2].value || []) : [],
    lastFetch: now
  };

  logger.debug(`Loaded Linear attributes: ${attributeCache.statuses.length} statuses, ${attributeCache.tiers.length} tiers, ${attributeCache.users.length} users`);
  
  // Log available tiers for debugging
  if (attributeCache.tiers.length > 0) {
    logger.debug('Available Linear tiers:', JSON.stringify(attributeCache.tiers.map(t => ({ 
      id: t.id, 
      name: t.name, 
      displayName: t.displayName 
    })), null, 2));
  }
  
  // Log which attributes failed to load (might not be available in workspace)
  if (results[0].status === 'rejected') logger.debug('Customer statuses not available');
  if (results[1].status === 'rejected') logger.debug('Customer tiers not available');
  if (results[2].status === 'rejected') logger.debug('Users query failed');

  return attributeCache;
}

// Status and tier mapping functions are now in utils/config.js
// They use a hybrid approach: exact name match first, then config file mapping


/**
 * Email mapping - maps HubSpot owner emails to Linear user emails
 * Use this when HubSpot users have different email addresses than their Linear accounts
 * Example: { 'john.doe@company.com': 'johnd@linear-workspace.com' }
 * 
 * For most setups, this can remain empty if users have the same email in both systems.
 * Consider moving to config/field-mappings.json for easier management.
 */
const EMAIL_MAPPING = {
  // 'hubspot-email@example.com': 'linear-email@example.com',
};

// Create reverse mapping automatically (Linear → HubSpot)
const REVERSE_EMAIL_MAPPING = Object.fromEntries(
  Object.entries(EMAIL_MAPPING).map(([hubspot, linear]) => [linear, hubspot])
);

/**
 * Map HubSpot owner to Linear user ID
 * Handles both owner ID (needs lookup) and direct email values
 */
async function mapOwnerToLinear(hubspotOwnerValue, linearUsers) {
  if (!hubspotOwnerValue || !linearUsers?.length) return null;

  try {
    let ownerEmail;
    
    // Check if the value is already an email (contains @)
    if (hubspotOwnerValue.includes('@')) {
      ownerEmail = hubspotOwnerValue;
      logger.debug(`Owner field contains email directly: ${ownerEmail}`);
    } else {
      // Assume it's an owner ID - try to fetch email from HubSpot
      const hubspotService = require('./hubspot');
      ownerEmail = await hubspotService.getOwnerEmail(hubspotOwnerValue);
      if (!ownerEmail) {
        logger.debug(`Could not fetch email for owner ID: ${hubspotOwnerValue}`);
        return null;
      }
      logger.debug(`Fetched owner email from ID ${hubspotOwnerValue}: ${ownerEmail}`);
    }

    // Check if we have a mapping for this email
    const mappedEmail = EMAIL_MAPPING[ownerEmail.toLowerCase()] || ownerEmail;
    
    // Find matching Linear user by email
    const matchingUser = linearUsers.find(user => 
      user.email?.toLowerCase() === mappedEmail.toLowerCase()
    );

    if (matchingUser) {
      logger.debug(`Mapped HubSpot owner ${ownerEmail} → Linear user ${matchingUser.email} (${matchingUser.id})`);
      return matchingUser.id;
    }

    logger.debug(`No Linear user found for HubSpot owner ${ownerEmail}`);
    return null;
  } catch (error) {
    logger.error('Error mapping owner to Linear:', error.message);
    return null;
  }
}

/**
 * Map HubSpot company properties to Linear customer input
 * Only includes fields that Linear supports and has valid values for
 */
async function mapHubSpotToLinear(hubspotCompany) {
  const properties = hubspotCompany.properties || hubspotCompany;
  const input = {};

  // Debug: log all properties we received (using configured field names)
  const fieldNames = {
    domain: config.getHubSpotField('domain'),
    size: config.getHubSpotField('size'),
    revenue: config.getHubSpotField('revenue'),
    status: config.getHubSpotField('status'),
    tier: config.getHubSpotField('tier'),
    owner: config.getHubSpotField('owner')
  };
  logger.debug('HubSpot properties received:', JSON.stringify({
    name: properties.name,
    [fieldNames.domain]: properties[fieldNames.domain],
    [fieldNames.size]: properties[fieldNames.size],
    [fieldNames.revenue]: properties[fieldNames.revenue],
    [fieldNames.status]: properties[fieldNames.status],
    [fieldNames.tier]: properties[fieldNames.tier],
    [fieldNames.owner]: properties[fieldNames.owner]
  }, null, 2));

  // Load Linear attributes for mapping (handles failures gracefully)
  const attributes = await loadLinearAttributes();
  
  // Map name (required field)
  if (properties.name) {
    input.name = properties.name.trim();
  }
  
  // Only include optional fields if Linear supports them and we have valid values
  // The Linear API may reject unknown fields, so we're conservative here
  
  // Map domain to domains array (only if Linear supports it)
  if (properties.domain) {
    input.domains = [properties.domain.trim()];
  }

  // Map logo URL - Linear only accepts URLs from https://public.linear.app
  // HubSpot logo URLs cannot be used directly
  if (properties.hs_logo_url && properties.hs_logo_url.includes('public.linear.app')) {
    input.logoUrl = properties.hs_logo_url;
  }

  // Map owner (using configurable HubSpot field) - handles both ID and email
  const ownerField = config.getHubSpotField('owner');
  if (properties[ownerField] && attributes.users?.length > 0) {
    const ownerId = await mapOwnerToLinear(properties[ownerField], attributes.users);
    if (ownerId) {
      input.ownerId = ownerId;
    }
  }

  // Map status (using configurable HubSpot field)
  const statusField = config.getHubSpotField('status');
  if (properties[statusField] && attributes.statuses?.length > 0) {
    const statusId = config.mapStatusHubSpotToLinear(properties[statusField], attributes.statuses);
    if (statusId) {
      input.statusId = statusId;
    }
  }

  // Map tier (using configurable HubSpot field)
  const tierField = config.getHubSpotField('tier');
  if (properties[tierField] && attributes.tiers?.length > 0) {
    const tierId = config.mapTierHubSpotToLinear(properties[tierField], attributes.tiers);
    if (tierId) {
      input.tierId = tierId;
    }
  }

  // Map annual revenue
  if (properties.annualrevenue) {
    const revenue = parseFloat(properties.annualrevenue);
    if (!isNaN(revenue)) {
      input.revenue = revenue;
    }
  }

  // Map employee count to size (number)
  if (properties.numberofemployees) {
    const count = parseInt(properties.numberofemployees, 10);
    if (!isNaN(count) && count > 0) {
      input.size = count;
    }
  }

  logger.debug('Mapped HubSpot company to Linear input:', JSON.stringify(input, null, 2));
  return input;
}

// Linear → HubSpot status and tier mapping functions are now in utils/config.js

/**
 * Map Linear size (number) to HubSpot numberofemployees
 */
function mapLinearSizeToHubSpot(linearSize) {
  if (linearSize === null || linearSize === undefined) return null;
  const size = typeof linearSize === 'number' ? linearSize : parseInt(linearSize, 10);
  return isNaN(size) ? null : String(size);
}

/**
 * Map Linear customer to HubSpot company properties
 */
async function mapLinearToHubSpot(linearCustomer) {
  const properties = {};
  
  // Map name (required field)
  if (linearCustomer.name) {
    properties.name = linearCustomer.name.trim();
  }
  
  // Map domains array to domain (use first domain)
  if (linearCustomer.domains && linearCustomer.domains.length > 0) {
    properties.domain = linearCustomer.domains[0];
  }

  // Map logo URL (only if it's from Linear's domain)
  if (linearCustomer.logoUrl && linearCustomer.logoUrl.includes('public.linear.app')) {
    properties.hs_logo_url = linearCustomer.logoUrl;
  }

  // Map owner (Linear user email → HubSpot owner field)
  const ownerField = config.getHubSpotField('owner');
  if (linearCustomer.owner?.email) {
    const linearEmail = linearCustomer.owner.email;
    // Check if we have a reverse mapping for this email
    const mappedEmail = REVERSE_EMAIL_MAPPING[linearEmail.toLowerCase()] || linearEmail;
    
    // Check if the owner field expects an email or an ID
    if (ownerField.toLowerCase().includes('email')) {
      // Field expects email directly
      properties[ownerField] = mappedEmail;
      logger.debug(`Mapped Linear owner ${linearEmail} → HubSpot ${ownerField}: ${mappedEmail}`);
    } else {
      // Field expects owner ID - look it up
      const ownerId = await hubspotService.getOwnerByEmail(mappedEmail);
      if (ownerId) {
        properties[ownerField] = ownerId;
        logger.debug(`Mapped Linear owner ${linearEmail} → HubSpot ${ownerField}: ${ownerId}`);
      }
    }
  }

  // Map status (using configurable HubSpot field)
  if (linearCustomer.status) {
    const statusValue = config.mapStatusLinearToHubSpot(linearCustomer.status);
    if (statusValue) {
      const statusField = config.getHubSpotField('status');
      properties[statusField] = statusValue;
    }
  }

  // Map tier (using configurable HubSpot field)
  if (linearCustomer.tier) {
    const tierValue = config.mapTierLinearToHubSpot(linearCustomer.tier);
    if (tierValue) {
      const tierField = config.getHubSpotField('tier');
      properties[tierField] = tierValue;
    }
  }

  // Map revenue (using configurable HubSpot field)
  if (linearCustomer.revenue !== undefined && linearCustomer.revenue !== null) {
    const revenueField = config.getHubSpotField('revenue');
    properties[revenueField] = String(linearCustomer.revenue);
  }

  // Map size (using configurable HubSpot field)
  if (linearCustomer.size !== null && linearCustomer.size !== undefined) {
    const employeeCount = mapLinearSizeToHubSpot(linearCustomer.size);
    if (employeeCount) {
      const sizeField = config.getHubSpotField('size');
      properties[sizeField] = employeeCount;
    }
  }

  logger.debug('Mapped Linear customer to HubSpot properties:', JSON.stringify(properties, null, 2));
  return properties;
}

/**
 * Find matching Linear customer by name
 */
async function findMatchingCustomer(hubspotCompany) {
  try {
    const properties = hubspotCompany.properties || hubspotCompany;
    const companyName = properties.name;
    const companyDomain = properties.domain;

    // First try to match by name
    if (companyName) {
      const matchByName = await linearService.searchCustomerByName(companyName);
      if (matchByName) {
        logger.debug(`Found Linear customer by name: ${matchByName.name}`);
        return matchByName;
      }
    }

    // If no name match, try to match by domain (important for name changes!)
    if (companyDomain) {
      const matchByDomain = await linearService.searchCustomerByDomain(companyDomain);
      if (matchByDomain) {
        logger.debug(`Found Linear customer by domain: ${matchByDomain.name} (domain: ${companyDomain})`);
        return matchByDomain;
      }
    }

    logger.debug(`No matching Linear customer found for "${companyName}" / "${companyDomain}"`);
    return null;
  } catch (error) {
    logger.error('Error finding matching Linear customer:', error.message);
    return null;
  }
}

/**
 * Find matching HubSpot company by name
 */
async function findMatchingCompany(linearCustomer) {
  try {
    const customerName = linearCustomer.name;
    if (!customerName) {
      logger.warn('Linear customer has no name, cannot find match');
      return null;
    }

    const matchingCompany = await hubspotService.searchCompanyByName(customerName);
    return matchingCompany;
  } catch (error) {
    logger.error('Error finding matching HubSpot company:', error.message);
    return null;
  }
}

/**
 * Sync HubSpot company to Linear customer
 */
async function syncHubSpotToLinear(hubspotCompany) {
  if (!shouldSyncCustomer()) {
    logger.debug('Customer sync is disabled, skipping HubSpot → Linear sync');
    return null;
  }

  const companyName = hubspotCompany.properties?.name || hubspotCompany.name;
  const lockKey = `sync:${normalizeName(companyName)}`;

  // Check for sync loop
  if (isSyncLocked(lockKey)) {
    logger.debug(`Sync already in progress for "${companyName}", skipping to prevent loop`);
    return null;
  }

  // Set lock before sync
  setSyncLock(lockKey);

  try {
    logger.info(`Syncing HubSpot company to Linear: ${companyName}`);
    
    // Get full company details if we only have ID
    let companyData = hubspotCompany;
    if (hubspotCompany.id && !hubspotCompany.properties) {
      const companyResult = await hubspotService.getCompany(hubspotCompany.id);
      companyData = companyResult;
    }

    // Find matching Linear customer
    const matchingCustomer = await findMatchingCustomer(companyData);
    
    // Map HubSpot company to Linear customer input
    const customerInput = await mapHubSpotToLinear(companyData);

    if (!customerInput.name) {
      logger.warn('Cannot sync company without name');
      return null;
    }

    if (matchingCustomer) {
      // Update existing customer
      logger.info(`Updating existing Linear customer: ${matchingCustomer.id} (${matchingCustomer.name})`);
      const updatedCustomer = await linearService.updateCustomer(matchingCustomer.id, customerInput);
      return updatedCustomer;
    } else {
      // Create new customer
      logger.info(`Creating new Linear customer: ${customerInput.name}`);
      const newCustomer = await linearService.createCustomer(customerInput);
      return newCustomer;
    }
  } catch (error) {
    logger.error('Error syncing HubSpot company to Linear:', error.message);
    // Don't throw - log error but continue processing
    return null;
  } finally {
    // Clear lock after a delay to prevent rapid re-triggers
    setTimeout(() => clearSyncLock(lockKey), 5000);
  }
}

/**
 * Sync Linear customer to HubSpot company
 */
async function syncLinearToHubSpot(linearCustomer) {
  if (!shouldSyncCustomer()) {
    logger.debug('Customer sync is disabled, skipping Linear → HubSpot sync');
    return null;
  }

  if (!isBidirectionalSync()) {
    logger.debug('Bidirectional sync is disabled, skipping Linear → HubSpot sync');
    return null;
  }

  const customerName = linearCustomer.name;
  const lockKey = `sync:${normalizeName(customerName)}`;

  // Check for sync loop
  if (isSyncLocked(lockKey)) {
    logger.debug(`Sync already in progress for "${customerName}", skipping to prevent loop`);
    return null;
  }

  // Set lock before sync
  setSyncLock(lockKey);

  try {
    logger.info(`Syncing Linear customer to HubSpot: ${customerName}`);
    
    // Get full customer details if we only have ID
    let customerData = linearCustomer;
    if (linearCustomer.id && !linearCustomer.name) {
      customerData = await linearService.getCustomer(linearCustomer.id);
    }

    // Find matching HubSpot company
    const matchingCompany = await findMatchingCompany(customerData);
    
    // Map Linear customer to HubSpot company properties
    const companyProperties = await mapLinearToHubSpot(customerData);

    if (!companyProperties.name) {
      logger.warn('Cannot sync customer without name');
      return null;
    }

    if (matchingCompany) {
      // Update existing company
      logger.info(`Updating existing HubSpot company: ${matchingCompany.id} (${matchingCompany.properties?.name})`);
      const updatedCompany = await hubspotService.updateCompany(matchingCompany.id, companyProperties);
      return updatedCompany;
    } else {
      // Create new company
      logger.info(`Creating new HubSpot company: ${companyProperties.name}`);
      const newCompany = await hubspotService.createCompany(companyProperties);
      return newCompany;
    }
  } catch (error) {
    logger.error('Error syncing Linear customer to HubSpot:', error.message);
    // Don't throw - log error but continue processing
    return null;
  } finally {
    // Clear lock after a delay to prevent rapid re-triggers
    setTimeout(() => clearSyncLock(lockKey), 5000);
  }
}

module.exports = {
  syncHubSpotToLinear,
  syncLinearToHubSpot,
  findMatchingCustomer,
  findMatchingCompany,
  mapHubSpotToLinear,
  mapLinearToHubSpot,
  shouldSyncCustomer,
  isBidirectionalSync,
  normalizeName,
  loadLinearAttributes
};
