/**
 * Data transformation engine - applies config mappings to Monday data
 */

import Mustache from 'mustache';
import type { ImportConfig, FieldMapping, TransformType } from '../config/schema.js';
import type { ParsedRow } from '../parser/excel.js';
import { getCellString, getCellNumber, getCellBoolean, parseTimeline, parseDate, parseMultiValue } from '../parser/excel.js';
import type { LinearClientWrapper } from '../linear/client.js';

export interface TransformedProject {
  type: 'project';
  name: string;
  description?: string;
  statusId?: string;
  priority?: number;
  startDate?: string;
  targetDate?: string;
  leadId?: string;
  labelIds: string[];
  memberIds?: string[];
  mondayId?: string;
  subitems?: TransformedIssue[];
  links?: { url: string; title: string }[];
  rawData: ParsedRow;
}

export interface TransformedIssue {
  type: 'issue';
  title: string;
  description?: string;
  stateId?: string;
  assigneeId?: string;
  priority?: number;
  estimate?: number;
  labelIds: string[];
  dueDate?: string;
  parentId?: string;
  mondayId?: string;
  links?: { url: string; title: string }[];
  rawData: ParsedRow;
}

export type TransformedItem = TransformedProject | TransformedIssue;

/**
 * Transform a row of Monday data into a Linear item
 */
export function transformRow(
  row: ParsedRow,
  config: ImportConfig,
  linearClient: LinearClientWrapper,
  resolvedLabels: Map<string, string[]>, // column -> labelIds for this row
): TransformedItem {
  const importAs = config.dataModel.items.importAs;
  const mappings = importAs === 'project' 
    ? config.fieldMappings?.project 
    : config.fieldMappings?.issue;

  if (importAs === 'project') {
    return transformToProject(row, config, mappings || {}, linearClient, resolvedLabels);
  } else {
    return transformToIssue(row, config, mappings || {}, linearClient, resolvedLabels);
  }
}

/**
 * Transform row to project
 */
function transformToProject(
  row: ParsedRow,
  config: ImportConfig,
  mappings: Record<string, FieldMapping>,
  linearClient: LinearClientWrapper,
  resolvedLabels: Map<string, string[]>,
): TransformedProject {
  const project: TransformedProject = {
    type: 'project',
    name: '',
    labelIds: [],
    rawData: row,
  };

  // Transform each mapped field
  for (const [field, mapping] of Object.entries(mappings)) {
    const value = transformField(row, mapping, config, linearClient);
    
    switch (field) {
      case 'name':
        project.name = truncate(String(value || 'Untitled'), 255);
        break;
      case 'description':
        project.description = value as string | undefined;
        break;
      case 'state':
        project.statusId = linearClient.resolveProjectStatusId(value as string) || undefined;
        break;
      case 'priority':
        project.priority = value as number | undefined;
        break;
      case 'startDate':
        project.startDate = value as string | undefined;
        break;
      case 'targetDate':
        project.targetDate = value as string | undefined;
        break;
      case 'lead':
        project.leadId = linearClient.resolveUserId(value as string) || undefined;
        break;
    }
  }

  // Get Monday ID
  if (config.source.identifierColumn) {
    project.mondayId = getCellString(row, config.source.identifierColumn) || undefined;
  }

  // Collect all label IDs
  for (const labelIds of resolvedLabels.values()) {
    project.labelIds.push(...labelIds);
  }

  // Extract links
  if (config.links?.enabled) {
    project.links = [];
    for (const linkCol of config.links.columns) {
      const url = getCellString(row, linkCol.source);
      if (url && url.startsWith('http')) {
        project.links.push({
          url,
          title: linkCol.title || linkCol.source,
        });
      }
    }
  }

  // Transform subitems
  if (config.dataModel.items.subitems?.enabled) {
    const subitemsConfig = config.dataModel.items.subitems;
    const subitemsValue = getCellString(row, subitemsConfig.sourceColumn);
    const subitemNames = parseMultiValue(subitemsValue, subitemsConfig.delimiter);
    
    project.subitems = subitemNames.map(name => ({
      type: 'issue' as const,
      title: truncate(name, 255),
      labelIds: [],
      rawData: row,
    }));
  }

  return project;
}

/**
 * Transform row to issue
 */
function transformToIssue(
  row: ParsedRow,
  config: ImportConfig,
  mappings: Record<string, FieldMapping>,
  linearClient: LinearClientWrapper,
  resolvedLabels: Map<string, string[]>,
): TransformedIssue {
  const issue: TransformedIssue = {
    type: 'issue',
    title: '',
    labelIds: [],
    rawData: row,
  };

  // Transform each mapped field
  for (const [field, mapping] of Object.entries(mappings)) {
    const value = transformField(row, mapping, config, linearClient);
    
    switch (field) {
      case 'title':
      case 'name':
        issue.title = truncate(String(value || 'Untitled'), 255);
        break;
      case 'description':
        issue.description = value as string | undefined;
        break;
      case 'state':
        issue.stateId = linearClient.resolveIssueStateId(value as string) || undefined;
        break;
      case 'assignee':
        issue.assigneeId = linearClient.resolveUserId(value as string) || undefined;
        break;
      case 'priority':
        issue.priority = value as number | undefined;
        break;
      case 'estimate':
        issue.estimate = value as number | undefined;
        break;
      case 'dueDate':
      case 'targetDate':
        issue.dueDate = value as string | undefined;
        break;
    }
  }

  // Get Monday ID
  if (config.source.identifierColumn) {
    issue.mondayId = getCellString(row, config.source.identifierColumn) || undefined;
  }

  // Collect all label IDs
  for (const labelIds of resolvedLabels.values()) {
    issue.labelIds.push(...labelIds);
  }

  // Extract links
  if (config.links?.enabled) {
    issue.links = [];
    for (const linkCol of config.links.columns) {
      const url = getCellString(row, linkCol.source);
      if (url && url.startsWith('http')) {
        issue.links.push({
          url,
          title: linkCol.title || linkCol.source,
        });
      }
    }
  }

  return issue;
}

/**
 * Transform a single field value
 */
function transformField(
  row: ParsedRow,
  mapping: FieldMapping,
  config: ImportConfig,
  linearClient: LinearClientWrapper,
): string | number | null {
  // Handle multi-source with template
  if (mapping.sources && mapping.template) {
    const values: Record<string, string> = {};
    for (const source of mapping.sources) {
      values[source] = getCellString(row, source) || '';
    }
    // Add special variables
    values['_mondayId'] = getCellString(row, config.source.identifierColumn || '') || '';
    values['_importDate'] = new Date().toISOString().split('T')[0];
    values['_rowNumber'] = String(row._rowNumber);
    
    // Filter out empty sections
    let rendered = Mustache.render(mapping.template, values);
    // Remove empty sections (## Header\n\n## NextHeader -> ## NextHeader)
    rendered = rendered.replace(/##\s+[^\n]+\n\s*\n+(?=##)/g, '');
    return rendered.trim() || null;
  }

  // Single source
  const source = mapping.source;
  if (!source) {
    return mapping.default ?? null;
  }

  const rawValue = getCellString(row, source);

  // Apply transform
  switch (mapping.transform) {
    case 'statusMap':
      return applyStatusMap(rawValue, config.statusMapping);
    
    case 'priorityMap':
      return applyPriorityMap(rawValue, config.priorityMapping);
    
    case 'date':
      return parseDate(rawValue);
    
    case 'timelineStart':
      return parseTimeline(rawValue).start;
    
    case 'timelineEnd':
      return parseTimeline(rawValue).end;
    
    case 'user':
      // Return raw value - resolution happens later
      return rawValue;
    
    case 'number':
      return getCellNumber(row, source);
    
    default:
      return rawValue ?? mapping.default ?? null;
  }
}

/**
 * Apply status mapping
 */
function applyStatusMap(value: string | null, mapping: Record<string, string>): string | null {
  if (!value) return mapping['_default'] ?? null;
  return mapping[value] ?? mapping['_default'] ?? value;
}

/**
 * Apply priority mapping
 */
function applyPriorityMap(value: string | null, mapping: Record<string, number>): number | null {
  if (!value) return mapping['_default'] ?? null;
  return mapping[value] ?? mapping['_default'] ?? null;
}

/**
 * Truncate string to max length
 */
function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength - 3) + '...';
}
