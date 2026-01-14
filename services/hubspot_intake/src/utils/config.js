const fs = require('fs');
const path = require('path');
const logger = require('./logger');

/**
 * Default configuration - used if config file doesn't exist
 */
const DEFAULT_CONFIG = {
  hubspotFields: {
    status: 'hs_lead_status',
    tier: 'hs_ideal_customer_profile',
    owner: 'hubspot_owner_id',
    revenue: 'annualrevenue',
    size: 'numberofemployees',
    domain: 'domain'
  },
  statusMapping: {
    hubspotToLinear: {},
    linearToHubspot: {}
  },
  tierMapping: {
    hubspotToLinear: {},
    linearToHubspot: {}
  }
};

let config = null;

/**
 * Load field mappings configuration
 * Looks for config/field-mappings.json, falls back to defaults if not found
 */
function loadConfig() {
  if (config) return config;

  const configPath = path.join(__dirname, '../../config/field-mappings.json');
  
  try {
    if (fs.existsSync(configPath)) {
      const fileContent = fs.readFileSync(configPath, 'utf8');
      const loadedConfig = JSON.parse(fileContent);
      
      // Merge with defaults to ensure all fields exist
      config = {
        hubspotFields: { ...DEFAULT_CONFIG.hubspotFields, ...loadedConfig.hubspotFields },
        statusMapping: {
          hubspotToLinear: { ...DEFAULT_CONFIG.statusMapping.hubspotToLinear, ...loadedConfig.statusMapping?.hubspotToLinear },
          linearToHubspot: { ...DEFAULT_CONFIG.statusMapping.linearToHubspot, ...loadedConfig.statusMapping?.linearToHubspot }
        },
        tierMapping: {
          hubspotToLinear: { ...DEFAULT_CONFIG.tierMapping.hubspotToLinear, ...loadedConfig.tierMapping?.hubspotToLinear },
          linearToHubspot: { ...DEFAULT_CONFIG.tierMapping.linearToHubspot, ...loadedConfig.tierMapping?.linearToHubspot }
        }
      };
      
      logger.info('Loaded field mappings from config/field-mappings.json');
      logger.debug('Config:', JSON.stringify(config, null, 2));
    } else {
      config = DEFAULT_CONFIG;
      logger.info('No field-mappings.json found, using defaults');
    }
  } catch (error) {
    logger.error('Error loading field-mappings.json:', error.message);
    config = DEFAULT_CONFIG;
  }

  return config;
}

/**
 * Get HubSpot field name for a given logical field
 */
function getHubSpotField(fieldName) {
  const cfg = loadConfig();
  return cfg.hubspotFields[fieldName] || fieldName;
}

/**
 * Map a HubSpot status value to Linear status name
 * First tries exact name match in Linear statuses, then normalized match, then falls back to config
 */
function mapStatusHubSpotToLinear(hubspotValue, linearStatuses) {
  if (!hubspotValue) return null;
  
  const rawValue = hubspotValue.trim();
  const normalizedValue = normalizeHubSpotValue(rawValue);
  
  // First try exact name match (case-insensitive) in Linear statuses
  if (linearStatuses?.length > 0) {
    // Try raw value first
    const exactMatch = linearStatuses.find(s => 
      s.name?.toLowerCase() === rawValue.toLowerCase() ||
      s.displayName?.toLowerCase() === rawValue.toLowerCase()
    );
    if (exactMatch) {
      logger.debug(`Status matched by exact name: ${hubspotValue} → ${exactMatch.name}`);
      return exactMatch.id;
    }
    
    // Try normalized value (in_progress → In Progress)
    const normalizedMatch = linearStatuses.find(s => 
      s.name?.toLowerCase() === normalizedValue.toLowerCase() ||
      s.displayName?.toLowerCase() === normalizedValue.toLowerCase()
    );
    if (normalizedMatch) {
      logger.debug(`Status matched by normalized name: ${hubspotValue} → ${normalizedValue} → ${normalizedMatch.name}`);
      return normalizedMatch.id;
    }
  }
  
  // Fall back to config mapping (try raw, uppercase, and normalized)
  const cfg = loadConfig();
  const mappedName = cfg.statusMapping.hubspotToLinear[rawValue] || 
                     cfg.statusMapping.hubspotToLinear[rawValue.toUpperCase()] ||
                     cfg.statusMapping.hubspotToLinear[normalizedValue];
  
  if (mappedName && linearStatuses?.length > 0) {
    const configMatch = linearStatuses.find(s => 
      s.name?.toLowerCase() === mappedName.toLowerCase() ||
      s.displayName?.toLowerCase() === mappedName.toLowerCase()
    );
    if (configMatch) {
      logger.debug(`Status matched by config: ${hubspotValue} → ${mappedName} → ${configMatch.name}`);
      return configMatch.id;
    }
  }
  
  logger.debug(`No status mapping found for: ${hubspotValue} (normalized: ${normalizedValue})`);
  return null;
}

/**
 * Map a Linear status to HubSpot status value
 * First tries exact name match, then falls back to config
 */
function mapStatusLinearToHubSpot(linearStatus) {
  if (!linearStatus?.name) return null;
  
  const statusName = linearStatus.name.trim();
  const cfg = loadConfig();
  
  // Check config mapping first (more specific)
  const mappedValue = cfg.statusMapping.linearToHubspot[statusName] ||
                      cfg.statusMapping.linearToHubspot[linearStatus.displayName];
  
  if (mappedValue) {
    logger.debug(`Status mapped by config: ${statusName} → ${mappedValue}`);
    return mappedValue;
  }
  
  // Fall back to returning the name as-is (might match if HubSpot has same value)
  logger.debug(`No status config mapping, using name: ${statusName}`);
  return statusName.toUpperCase().replace(/\s+/g, '_');
}

/**
 * Normalize HubSpot internal value to display format
 * e.g., "tier_1" → "Tier 1", "some_value_here" → "Some Value Here"
 */
function normalizeHubSpotValue(value) {
  if (!value) return value;
  
  // Replace underscores with spaces and convert to title case
  return value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase());
}

/**
 * Map a HubSpot tier value to Linear tier name
 * First tries exact name match in Linear tiers, then normalized match, then falls back to config
 */
function mapTierHubSpotToLinear(hubspotValue, linearTiers) {
  if (hubspotValue === null || hubspotValue === undefined) return null;
  
  const rawValue = String(hubspotValue).trim();
  const normalizedValue = normalizeHubSpotValue(rawValue);
  
  // First try exact name match (case-insensitive) in Linear tiers
  if (linearTiers?.length > 0) {
    // Try raw value first
    const exactMatch = linearTiers.find(t => 
      t.name?.toLowerCase() === rawValue.toLowerCase() ||
      t.displayName?.toLowerCase() === rawValue.toLowerCase()
    );
    if (exactMatch) {
      logger.debug(`Tier matched by exact name: ${hubspotValue} → ${exactMatch.name}`);
      return exactMatch.id;
    }
    
    // Try normalized value (tier_1 → Tier 1)
    const normalizedMatch = linearTiers.find(t => 
      t.name?.toLowerCase() === normalizedValue.toLowerCase() ||
      t.displayName?.toLowerCase() === normalizedValue.toLowerCase()
    );
    if (normalizedMatch) {
      logger.debug(`Tier matched by normalized name: ${hubspotValue} → ${normalizedValue} → ${normalizedMatch.name}`);
      return normalizedMatch.id;
    }
  }
  
  // Fall back to config mapping (try both raw and normalized)
  const cfg = loadConfig();
  const mappedName = cfg.tierMapping.hubspotToLinear[rawValue] || 
                     cfg.tierMapping.hubspotToLinear[rawValue.toLowerCase()] ||
                     cfg.tierMapping.hubspotToLinear[normalizedValue];
  
  if (mappedName && linearTiers?.length > 0) {
    const configMatch = linearTiers.find(t => 
      t.name?.toLowerCase() === mappedName.toLowerCase() ||
      t.displayName?.toLowerCase() === mappedName.toLowerCase()
    );
    if (configMatch) {
      logger.debug(`Tier matched by config: ${hubspotValue} → ${mappedName} → ${configMatch.name}`);
      return configMatch.id;
    }
  }
  
  logger.debug(`No tier mapping found for: ${hubspotValue} (normalized: ${normalizedValue})`);
  return null;
}

/**
 * Map a Linear tier to HubSpot tier value
 * First checks config, then falls back to name
 */
function mapTierLinearToHubSpot(linearTier) {
  if (!linearTier?.name) return null;
  
  const tierName = linearTier.name.trim();
  const cfg = loadConfig();
  
  // Check config mapping first
  const mappedValue = cfg.tierMapping.linearToHubspot[tierName] ||
                      cfg.tierMapping.linearToHubspot[linearTier.displayName];
  
  if (mappedValue) {
    logger.debug(`Tier mapped by config: ${tierName} → ${mappedValue}`);
    return mappedValue;
  }
  
  // Fall back to returning the name as-is
  logger.debug(`No tier config mapping, using name: ${tierName}`);
  return tierName;
}

/**
 * Get all HubSpot fields that should be fetched for customer sync
 */
function getHubSpotFieldsToFetch() {
  const cfg = loadConfig();
  return [
    'name',
    cfg.hubspotFields.domain,
    cfg.hubspotFields.revenue,
    cfg.hubspotFields.size,
    cfg.hubspotFields.status,
    cfg.hubspotFields.tier,
    cfg.hubspotFields.owner,
    'description',
    'website',
    'industry',
    'createdate',
    'hs_lastmodifieddate'
  ];
}

module.exports = {
  loadConfig,
  getHubSpotField,
  getHubSpotFieldsToFetch,
  mapStatusHubSpotToLinear,
  mapStatusLinearToHubSpot,
  mapTierHubSpotToLinear,
  mapTierLinearToHubSpot
};
