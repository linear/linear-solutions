/**
 * Generic Excel parser for Monday.com exports
 */

import XLSX from 'xlsx';
import type { SourceConfig } from '../config/schema.js';

export interface ParsedRow {
  _rowNumber: number;
  _rawData: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ParsedSheet {
  name: string;
  headers: string[];
  rows: ParsedRow[];
}

export interface ParsedExcel {
  sheets: Map<string, ParsedSheet>;
  sheetNames: string[];
}

/**
 * Parse an Excel file and return structured data
 */
export function parseExcel(filePath: string): ParsedExcel {
  const workbook = XLSX.readFile(filePath, { 
    cellDates: true,
    cellNF: true,
  });

  const sheets = new Map<string, ParsedSheet>();

  for (const sheetName of workbook.SheetNames) {
    const worksheet = workbook.Sheets[sheetName];
    const jsonData = XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, {
      raw: false,
      dateNF: 'yyyy-mm-dd',
      defval: null,
    });

    // Extract headers from the first row
    const range = XLSX.utils.decode_range(worksheet['!ref'] || 'A1');
    const headers: string[] = [];
    for (let col = range.s.c; col <= range.e.c; col++) {
      const cellAddress = XLSX.utils.encode_cell({ r: range.s.r, c: col });
      const cell = worksheet[cellAddress];
      headers.push(cell?.v?.toString() || `Column${col + 1}`);
    }

    // Convert to ParsedRow format
    const rows: ParsedRow[] = jsonData.map((row, index) => ({
      _rowNumber: index + 2, // +2 because 1-indexed and header row
      _rawData: row,
      ...row,
    }));

    sheets.set(sheetName, {
      name: sheetName,
      headers,
      rows,
    });
  }

  return {
    sheets,
    sheetNames: workbook.SheetNames,
  };
}

/**
 * Get a specific sheet from parsed Excel
 */
export function getSheet(parsed: ParsedExcel, sheetName: string): ParsedSheet | null {
  // Try exact match first
  if (parsed.sheets.has(sheetName)) {
    return parsed.sheets.get(sheetName)!;
  }

  // Try case-insensitive match
  for (const [name, sheet] of parsed.sheets) {
    if (name.toLowerCase() === sheetName.toLowerCase()) {
      return sheet;
    }
  }

  // Try partial match
  for (const [name, sheet] of parsed.sheets) {
    if (name.toLowerCase().includes(sheetName.toLowerCase())) {
      return sheet;
    }
  }

  return null;
}

/**
 * Get cell value as string, handling various types
 */
export function getCellString(row: ParsedRow, column: string): string | null {
  const value = row[column];
  
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }

  if (value instanceof Date) {
    return value.toISOString().split('T')[0];
  }

  return String(value).trim();
}

/**
 * Get cell value as number
 */
export function getCellNumber(row: ParsedRow, column: string): number | null {
  const value = row[column];
  
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'number') {
    return value;
  }

  const parsed = parseFloat(String(value).replace(/[^0-9.-]/g, ''));
  return isNaN(parsed) ? null : parsed;
}

/**
 * Get cell value as boolean (for checkboxes)
 */
export function getCellBoolean(row: ParsedRow, column: string): boolean {
  const value = row[column];
  
  if (value === null || value === undefined) {
    return false;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  const strValue = String(value).toLowerCase().trim();
  return ['true', 'yes', '1', 'checked', '✓', '✔', 'x'].includes(strValue);
}

/**
 * Parse timeline/date range column (e.g., "2024-01-15 to 2024-03-30")
 */
export function parseTimeline(value: string | null): { start: string | null; end: string | null } {
  if (!value) {
    return { start: null, end: null };
  }

  // Try various date range formats
  const patterns = [
    /^(\d{4}-\d{2}-\d{2})\s*(?:to|-|–)\s*(\d{4}-\d{2}-\d{2})$/i,
    /^([A-Za-z]+ \d{1,2},? \d{4})\s*(?:to|-|–)\s*([A-Za-z]+ \d{1,2},? \d{4})$/i,
    /^(\d{1,2}\/\d{1,2}\/\d{4})\s*(?:to|-|–)\s*(\d{1,2}\/\d{1,2}\/\d{4})$/i,
  ];

  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) {
      return {
        start: parseDate(match[1]),
        end: parseDate(match[2]),
      };
    }
  }

  // If not a range, try parsing as single date
  const singleDate = parseDate(value);
  return { start: singleDate, end: null };
}

/**
 * Parse a date string into ISO format
 */
export function parseDate(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  
  // Already ISO format
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }

  // Try parsing with Date
  const date = new Date(trimmed);
  if (!isNaN(date.getTime())) {
    return date.toISOString().split('T')[0];
  }

  // Try MM/DD/YYYY format
  const usMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (usMatch) {
    const [, month, day, year] = usMatch;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  return null;
}

/**
 * Parse multi-value cell (comma-separated, newline-separated, etc.)
 */
export function parseMultiValue(value: string | null, delimiter: string = ','): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(delimiter)
    .map(v => v.trim())
    .filter(v => v.length > 0);
}

/**
 * Extract unique values from a column across all rows
 */
export function getUniqueColumnValues(rows: ParsedRow[], column: string): Set<string> {
  const values = new Set<string>();
  
  for (const row of rows) {
    const value = getCellString(row, column);
    if (value) {
      values.add(value);
    }
  }

  return values;
}
