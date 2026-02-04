/**
 * Config generator from wizard answers
 */

import type { ImportConfig, LabelConfig, FieldMapping } from '../config/schema.js';
import type { ColumnAnalysis } from './detector.js';

export interface WizardAnswers {
  // Source
  itemsSheet: string;
  updatesSheet?: string;
  identifierColumn?: string;
  
  // Data model
  importAs: 'project' | 'issue' | 'parentIssue';
  subitemsColumn?: string;
  subitemsDelimiter?: string;
  
  // Field mappings
  nameColumn: string;
  descriptionColumns: string[];
  statusColumn?: string;
  statusMappings?: Record<string, string>;
  priorityColumn?: string;
  priorityMappings?: Record<string, number>;
  startDateColumn?: string;
  endDateColumn?: string;
  timelineColumn?: string;
  leadColumn?: string;
  assigneeColumn?: string;
  estimateColumn?: string;
  
  // Subitem/Issue field mappings (for subitems imported as issues)
  subitemFieldMappings?: Record<string, FieldMapping>;
  issueStatusMappings?: Record<string, string>;
  
  // Labels
  labelColumns: string[];
  labelPrefixes: Record<string, string | null>;
  flatLabels: string[];
  
  // Groups
  groupColumn?: string;
  groupName?: string;
  
  // Checkboxes
  checkboxColumns: { column: string; label: string }[];
  
  // Links
  linkColumns: { column: string; title?: string }[];
  
  // Dependencies
  blocksColumn?: string;
  blockedByColumn?: string;
  dependencyMatchBy?: 'name' | 'mondayId';
  
  // Updates
  updatesEnabled: boolean;
  updatesDateColumn?: string;
  updatesAuthorColumn?: string;
  updatesContentColumn?: string;
  updatesLinkColumn?: string;
  
  // Deduplication
  deduplicationEnabled: boolean;
  deduplicationMatchBy?: string;
  deduplicationOnDuplicate?: 'skip' | 'update' | 'create';
}

/**
 * Generate config from wizard answers
 */
export function generateConfig(answers: WizardAnswers): ImportConfig {
  const config: ImportConfig = {
    version: '1.0',
    source: {
      sheets: {
        items: answers.itemsSheet,
        updates: answers.updatesSheet,
      },
      headerRow: 1,
      identifierColumn: answers.identifierColumn,
    },
    target: {
      team: 'prompt',
      createMissingLabels: true,
    },
    dataModel: {
      items: {
        importAs: answers.importAs,
        subitems: answers.subitemsColumn ? {
          enabled: true,
          importAs: 'issue',
          sourceColumn: answers.subitemsColumn,
          delimiter: answers.subitemsDelimiter || ',',
        } : undefined,
      },
    },
    fieldMappings: buildFieldMappings(answers),
    statusMapping: answers.statusMappings || { '_default': 'Backlog' },
    issueStatusMapping: answers.issueStatusMappings,
    priorityMapping: answers.priorityMappings || { '_default': 0 },
    labels: buildLabelConfigs(answers),
    groups: answers.groupColumn ? {
      enabled: true,
      sourceColumn: answers.groupColumn,
      groupName: answers.groupName || 'Board Section',
    } : undefined,
    checkboxes: answers.checkboxColumns.map(cb => ({
      sourceColumn: cb.column,
      labelWhenChecked: cb.label,
    })),
    links: answers.linkColumns.length > 0 ? {
      enabled: true,
      columns: answers.linkColumns.map(lc => ({
        source: lc.column,
        title: lc.title,
      })),
    } : undefined,
    dependencies: (answers.blocksColumn || answers.blockedByColumn) ? {
      enabled: true,
      blocksColumn: answers.blocksColumn,
      blockedByColumn: answers.blockedByColumn,
      matchBy: answers.dependencyMatchBy || 'name',
    } : undefined,
    updates: answers.updatesEnabled ? {
      enabled: true,
      dateColumn: answers.updatesDateColumn,
      authorColumn: answers.updatesAuthorColumn,
      contentColumn: answers.updatesContentColumn,
      linkColumn: answers.updatesLinkColumn,
      sortOrder: 'asc',
      authorFallback: 'prepend',
    } : undefined,
    options: {
      continueOnError: true,
      rateLimitMs: 100,
      skipEmpty: true,
    },
    deduplication: answers.deduplicationEnabled ? {
      enabled: true,
      matchBy: answers.deduplicationMatchBy || 'Item ID',
      onDuplicate: answers.deduplicationOnDuplicate || 'skip',
    } : undefined,
  };

  return config;
}

/**
 * Build field mappings from answers
 */
function buildFieldMappings(answers: WizardAnswers): ImportConfig['fieldMappings'] {
  const mappings: Record<string, FieldMapping> = {};

  // Name field
  mappings.name = { source: answers.nameColumn };

  // Description (multi-source)
  if (answers.descriptionColumns.length > 0) {
    if (answers.descriptionColumns.length === 1) {
      mappings.description = { source: answers.descriptionColumns[0] };
    } else {
      const templateParts = answers.descriptionColumns.map(col => 
        `## ${col}\n{{${col}}}`
      );
      mappings.description = {
        sources: answers.descriptionColumns,
        template: templateParts.join('\n\n') + '\n\n---\n_Imported from Monday.com_',
      };
    }
  }

  // Status
  if (answers.statusColumn) {
    mappings.state = { source: answers.statusColumn, transform: 'statusMap' };
  }

  // Priority
  if (answers.priorityColumn) {
    mappings.priority = { source: answers.priorityColumn, transform: 'priorityMap' };
  }

  // Dates
  if (answers.timelineColumn) {
    mappings.startDate = { source: answers.timelineColumn, transform: 'timelineStart' };
    mappings.targetDate = { source: answers.timelineColumn, transform: 'timelineEnd' };
  } else {
    if (answers.startDateColumn) {
      mappings.startDate = { source: answers.startDateColumn, transform: 'date' };
    }
    if (answers.endDateColumn) {
      mappings.targetDate = { source: answers.endDateColumn, transform: 'date' };
    }
  }

  // Lead/Assignee
  if (answers.leadColumn) {
    mappings.lead = { source: answers.leadColumn, transform: 'user' };
  }
  if (answers.assigneeColumn) {
    mappings.assignee = { source: answers.assigneeColumn, transform: 'user' };
  }

  // Estimate
  if (answers.estimateColumn) {
    mappings.estimate = { source: answers.estimateColumn, transform: 'number' };
  }

  // Return appropriate mapping based on import type
  const result: ImportConfig['fieldMappings'] = {};
  
  if (answers.importAs === 'project') {
    result.project = mappings;
    // Include subitem field mappings as issue mappings when subitems are enabled
    if (answers.subitemsColumn && answers.subitemFieldMappings) {
      result.issue = answers.subitemFieldMappings;
    }
  } else {
    result.issue = mappings;
  }
  
  return result;
}

/**
 * Build label configs from answers
 */
function buildLabelConfigs(answers: WizardAnswers): LabelConfig[] {
  const configs: LabelConfig[] = [];

  for (const column of answers.labelColumns) {
    const isFlat = answers.flatLabels.includes(column);
    const prefix = answers.labelPrefixes[column];

    configs.push({
      sourceColumn: column,
      groupName: isFlat ? undefined : (prefix || column),
      flat: isFlat,
      createGroup: !isFlat,
    });
  }

  return configs;
}

/**
 * Generate default config template
 */
export function generateDefaultConfigTemplate(): ImportConfig {
  return {
    version: '1.0',
    source: {
      sheets: {
        items: 'Sheet1',
        updates: 'Sheet2',
      },
      headerRow: 1,
      identifierColumn: 'Item ID',
    },
    target: {
      team: 'prompt',
      createMissingLabels: true,
    },
    dataModel: {
      items: {
        importAs: 'project',
        subitems: {
          enabled: false,
          importAs: 'issue',
          sourceColumn: 'Subitems',
          delimiter: ',',
        },
      },
    },
    fieldMappings: {
      project: {
        name: { source: 'Name' },
        description: { 
          sources: ['Description'],
          template: '{{Description}}\n\n---\n_Imported from Monday.com_',
        },
        state: { source: 'Status', transform: 'statusMap' },
        priority: { source: 'Priority', transform: 'priorityMap' },
        startDate: { source: 'Start Date', transform: 'date' },
        targetDate: { source: 'End Date', transform: 'date' },
        lead: { source: 'Owner', transform: 'user' },
      },
    },
    statusMapping: {
      'Not Started': 'Backlog',
      'Planning': 'Planned',
      'In Progress': 'Started',
      'Done': 'Completed',
      'Completed': 'Completed',
      '_default': 'Backlog',
    },
    priorityMapping: {
      'Critical': 1,
      'High': 2,
      'Medium': 3,
      'Low': 4,
      '_default': 0,
    },
    labels: [
      {
        sourceColumn: 'Category',
        groupName: 'Category',
        createGroup: true,
      },
    ],
    options: {
      continueOnError: true,
      rateLimitMs: 100,
      skipEmpty: true,
    },
  };
}
