/**
 * Configuration validation
 */

import type { ImportConfig } from './schema.js';

export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidationWarning {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

/**
 * Validate the configuration structure
 */
export function validateConfig(config: ImportConfig): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  // Required fields
  if (!config.version) {
    errors.push({ path: 'version', message: 'Version is required' });
  }

  if (!config.source?.sheets?.items) {
    errors.push({ path: 'source.sheets.items', message: 'Items sheet name is required' });
  }

  if (!config.dataModel?.items?.importAs) {
    errors.push({ path: 'dataModel.items.importAs', message: 'Import type (project/issue) is required' });
  }

  // Validate importAs value
  const validImportAs = ['project', 'issue', 'parentIssue'];
  if (config.dataModel?.items?.importAs && !validImportAs.includes(config.dataModel.items.importAs)) {
    errors.push({ 
      path: 'dataModel.items.importAs', 
      message: `Invalid importAs value. Must be one of: ${validImportAs.join(', ')}` 
    });
  }

  // Validate field mappings exist for the import type
  const importAs = config.dataModel?.items?.importAs;
  if (importAs === 'project' && !config.fieldMappings?.project) {
    warnings.push({ 
      path: 'fieldMappings.project', 
      message: 'No field mappings defined for projects' 
    });
  }
  if ((importAs === 'issue' || importAs === 'parentIssue') && !config.fieldMappings?.issue) {
    warnings.push({ 
      path: 'fieldMappings.issue', 
      message: 'No field mappings defined for issues' 
    });
  }

  // Validate subitems config if enabled
  if (config.dataModel?.items?.subitems?.enabled) {
    const subitems = config.dataModel.items.subitems;
    if (!subitems.sourceColumn) {
      errors.push({ 
        path: 'dataModel.items.subitems.sourceColumn', 
        message: 'Subitems source column is required when subitems are enabled' 
      });
    }
    if (!subitems.delimiter) {
      warnings.push({ 
        path: 'dataModel.items.subitems.delimiter', 
        message: 'No delimiter specified for subitems, defaulting to ","' 
      });
    }
  }

  // Validate label configs
  for (let i = 0; i < (config.labels?.length ?? 0); i++) {
    const label = config.labels![i];
    if (!label.sourceColumn) {
      errors.push({ 
        path: `labels[${i}].sourceColumn`, 
        message: 'Label source column is required' 
      });
    }
  }

  // Validate dependencies config
  if (config.dependencies?.enabled) {
    if (!config.dependencies.blocksColumn && !config.dependencies.blockedByColumn) {
      errors.push({ 
        path: 'dependencies', 
        message: 'At least one of blocksColumn or blockedByColumn is required when dependencies are enabled' 
      });
    }
  }

  // Validate updates config
  if (config.updates?.enabled) {
    if (!config.updates.contentColumn) {
      errors.push({ 
        path: 'updates.contentColumn', 
        message: 'Updates content column is required when updates are enabled' 
      });
    }
    if (!config.updates.linkColumn) {
      errors.push({ 
        path: 'updates.linkColumn', 
        message: 'Updates link column is required to match updates to items' 
      });
    }
  }

  // Validate deduplication config
  if (config.deduplication?.enabled) {
    if (!config.deduplication.matchBy) {
      errors.push({ 
        path: 'deduplication.matchBy', 
        message: 'Deduplication matchBy field is required' 
      });
    }
    const validOnDuplicate = ['skip', 'update', 'create'];
    if (!validOnDuplicate.includes(config.deduplication.onDuplicate)) {
      errors.push({ 
        path: 'deduplication.onDuplicate', 
        message: `Invalid onDuplicate value. Must be one of: ${validOnDuplicate.join(', ')}` 
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate config against Excel columns
 */
export function validateConfigAgainstExcel(
  config: ImportConfig, 
  columns: string[]
): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];
  const columnSet = new Set(columns.map(c => c.toLowerCase()));

  const checkColumn = (path: string, columnName: string | undefined) => {
    if (columnName && !columnSet.has(columnName.toLowerCase())) {
      errors.push({ 
        path, 
        message: `Column "${columnName}" not found in Excel. Available: ${columns.slice(0, 10).join(', ')}${columns.length > 10 ? '...' : ''}` 
      });
    }
  };

  // Check field mappings
  const mappings = config.dataModel.items.importAs === 'project' 
    ? config.fieldMappings?.project 
    : config.fieldMappings?.issue;
  
  if (mappings) {
    for (const [field, mapping] of Object.entries(mappings)) {
      if (mapping.source) {
        checkColumn(`fieldMappings.${field}.source`, mapping.source);
      }
      if (mapping.sources) {
        for (const source of mapping.sources) {
          checkColumn(`fieldMappings.${field}.sources`, source);
        }
      }
    }
  }

  // Check label columns
  for (let i = 0; i < (config.labels?.length ?? 0); i++) {
    checkColumn(`labels[${i}].sourceColumn`, config.labels![i].sourceColumn);
  }

  // Check groups column
  if (config.groups?.enabled) {
    checkColumn('groups.sourceColumn', config.groups.sourceColumn);
  }

  // Check checkbox columns
  for (let i = 0; i < (config.checkboxes?.length ?? 0); i++) {
    checkColumn(`checkboxes[${i}].sourceColumn`, config.checkboxes![i].sourceColumn);
  }

  // Check link columns
  if (config.links?.enabled) {
    for (let i = 0; i < config.links.columns.length; i++) {
      checkColumn(`links.columns[${i}].source`, config.links.columns[i].source);
    }
  }

  // Check dependency columns
  if (config.dependencies?.enabled) {
    checkColumn('dependencies.blocksColumn', config.dependencies.blocksColumn);
    checkColumn('dependencies.blockedByColumn', config.dependencies.blockedByColumn);
  }

  // Check identifier column
  checkColumn('source.identifierColumn', config.source.identifierColumn);
  checkColumn('source.groupColumn', config.source.groupColumn);

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
