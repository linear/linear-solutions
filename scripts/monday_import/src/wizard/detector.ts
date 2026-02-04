/**
 * Column type detection for Monday.com exports
 */

import type { ParsedRow } from '../parser/excel.js';
import { getCellString } from '../parser/excel.js';

export type ColumnType = 
  | 'text'
  | 'longText'
  | 'date'
  | 'timeline'
  | 'number'
  | 'enum'
  | 'person'
  | 'multiValue'
  | 'checkbox'
  | 'link'
  | 'identifier';

export interface ColumnAnalysis {
  name: string;
  type: ColumnType;
  confidence: number;
  sampleValues: string[];
  uniqueCount: number;
  emptyCount: number;
  totalCount: number;
  suggestedMapping?: string;
}

/**
 * Analyze all columns in a sheet
 */
export function analyzeColumns(rows: ParsedRow[], headers: string[]): ColumnAnalysis[] {
  const analyses: ColumnAnalysis[] = [];

  for (const header of headers) {
    const analysis = analyzeColumn(header, rows);
    analyses.push(analysis);
  }

  return analyses;
}

/**
 * Analyze a single column
 */
export function analyzeColumn(columnName: string, rows: ParsedRow[]): ColumnAnalysis {
  const values: string[] = [];
  const uniqueValues = new Set<string>();
  let emptyCount = 0;
  let totalLength = 0;

  for (const row of rows) {
    const value = getCellString(row, columnName);
    if (value === null || value === '') {
      emptyCount++;
    } else {
      values.push(value);
      uniqueValues.add(value);
      totalLength += value.length;
    }
  }

  const totalCount = rows.length;
  const nonEmptyCount = values.length;
  const avgLength = nonEmptyCount > 0 ? totalLength / nonEmptyCount : 0;

  // Detect type
  const { type, confidence } = detectColumnType(columnName, values, uniqueValues.size, avgLength, totalCount);

  // Suggest mapping based on column name
  const suggestedMapping = suggestMapping(columnName);

  return {
    name: columnName,
    type,
    confidence,
    sampleValues: values.slice(0, 5),
    uniqueCount: uniqueValues.size,
    emptyCount,
    totalCount,
    suggestedMapping,
  };
}

/**
 * Detect the type of a column based on its values
 */
function detectColumnType(
  columnName: string,
  values: string[],
  uniqueCount: number,
  avgLength: number,
  totalCount: number
): { type: ColumnType; confidence: number } {
  if (values.length === 0) {
    return { type: 'text', confidence: 0.5 };
  }

  const lowerName = columnName.toLowerCase();

  // Check for identifier column
  if (
    (lowerName.includes('id') || lowerName.includes('identifier')) &&
    uniqueCount === values.length
  ) {
    return { type: 'identifier', confidence: 0.9 };
  }

  // Check for timeline (date range)
  const timelineCount = values.filter(isTimeline).length;
  if (timelineCount > values.length * 0.5) {
    return { type: 'timeline', confidence: timelineCount / values.length };
  }

  // Check for date
  const dateCount = values.filter(isDate).length;
  if (dateCount > values.length * 0.7) {
    return { type: 'date', confidence: dateCount / values.length };
  }

  // Check for checkbox
  const checkboxCount = values.filter(isCheckboxValue).length;
  if (checkboxCount > values.length * 0.8) {
    return { type: 'checkbox', confidence: checkboxCount / values.length };
  }

  // Check for link
  const linkCount = values.filter(isLink).length;
  if (linkCount > values.length * 0.7) {
    return { type: 'link', confidence: linkCount / values.length };
  }

  // Check for number
  const numberCount = values.filter(isNumeric).length;
  if (numberCount > values.length * 0.8) {
    return { type: 'number', confidence: numberCount / values.length };
  }

  // Check for person (name pattern)
  const personCount = values.filter(isPerson).length;
  if (personCount > values.length * 0.6 || lowerName.includes('owner') || 
      lowerName.includes('assignee') || lowerName.includes('manager') ||
      lowerName.includes('lead')) {
    return { type: 'person', confidence: Math.max(0.7, personCount / values.length) };
  }

  // Check for multi-value
  const multiValueCount = values.filter(v => v.includes(',') && v.split(',').length > 1).length;
  if (multiValueCount > values.length * 0.3) {
    return { type: 'multiValue', confidence: multiValueCount / values.length };
  }

  // Check for enum (limited set of values)
  if (uniqueCount < 20 && uniqueCount < totalCount * 0.3) {
    return { type: 'enum', confidence: 0.8 };
  }

  // Check for long text
  if (avgLength > 100) {
    return { type: 'longText', confidence: 0.8 };
  }

  return { type: 'text', confidence: 0.6 };
}

/**
 * Check if value looks like a date range
 */
function isTimeline(value: string): boolean {
  const patterns = [
    /\d{4}-\d{2}-\d{2}\s*(to|-|–)\s*\d{4}-\d{2}-\d{2}/i,
    /[A-Za-z]+ \d{1,2},? \d{4}\s*(to|-|–)\s*[A-Za-z]+ \d{1,2},? \d{4}/i,
  ];
  return patterns.some(p => p.test(value));
}

/**
 * Check if value looks like a date
 */
function isDate(value: string): boolean {
  // ISO format
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return true;
  
  // US format
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(value)) return true;
  
  // Month name format
  if (/^[A-Za-z]+ \d{1,2},? \d{4}/.test(value)) return true;
  
  // Try Date.parse
  const parsed = Date.parse(value);
  return !isNaN(parsed) && value.length > 4;
}

/**
 * Check if value looks like a checkbox
 */
function isCheckboxValue(value: string): boolean {
  const lower = value.toLowerCase().trim();
  return ['true', 'false', 'yes', 'no', '1', '0', 'checked', 'unchecked', '✓', '✔', 'x', ''].includes(lower);
}

/**
 * Check if value looks like a URL
 */
function isLink(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/**
 * Check if value is numeric
 */
function isNumeric(value: string): boolean {
  const cleaned = value.replace(/[$,€£¥]/g, '').trim();
  return !isNaN(parseFloat(cleaned)) && isFinite(parseFloat(cleaned));
}

/**
 * Check if value looks like a person name
 */
function isPerson(value: string): boolean {
  // Email
  if (value.includes('@')) return true;
  
  // Name pattern (First Last or First M. Last)
  if (/^[A-Z][a-z]+\s+[A-Z][a-z]+/.test(value)) return true;
  
  // Multiple names separated by comma/newline
  if (/^[A-Z][a-z]+,?\s/.test(value)) return true;
  
  return false;
}

/**
 * Suggest field mapping based on column name
 */
function suggestMapping(columnName: string): string | undefined {
  const lower = columnName.toLowerCase();
  
  const mappings: [RegExp, string][] = [
    [/^name$|^title$|^item$/i, 'name'],
    [/description|summary|details|overview/i, 'description'],
    [/status|state|lifecycle/i, 'state'],
    [/priority|urgency/i, 'priority'],
    [/owner|lead|manager|pm\b/i, 'lead'],
    [/assignee/i, 'assignee'],
    [/^start|begin/i, 'startDate'],
    [/^end$|due|target|deadline/i, 'targetDate'],
    [/timeline|dates|duration/i, 'timeline'],
    [/points|estimate|story/i, 'estimate'],
    [/group|section/i, 'group'],
    [/link|url/i, 'link'],
    [/blocks|blocked|depend/i, 'dependency'],
  ];

  for (const [pattern, mapping] of mappings) {
    if (pattern.test(lower)) {
      return mapping;
    }
  }

  return undefined;
}

/**
 * Get columns by detected type
 */
export function getColumnsByType(analyses: ColumnAnalysis[], type: ColumnType): ColumnAnalysis[] {
  return analyses.filter(a => a.type === type);
}

/**
 * Get columns suitable for labels (enum-like)
 */
export function getLabelCandidates(analyses: ColumnAnalysis[]): ColumnAnalysis[] {
  return analyses.filter(a => 
    a.type === 'enum' || 
    (a.type === 'text' && a.uniqueCount < 20 && a.uniqueCount > 1)
  );
}

/**
 * Get columns suitable for status mapping
 */
export function getStatusCandidates(analyses: ColumnAnalysis[]): ColumnAnalysis[] {
  return analyses.filter(a => 
    a.type === 'enum' && 
    (a.suggestedMapping === 'state' || a.name.toLowerCase().includes('status'))
  );
}
