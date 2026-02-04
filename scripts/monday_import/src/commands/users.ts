/**
 * Users command - generate user mapping template
 */

import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { parseExcel, getSheet, getCellString, getUniqueColumnValues } from '../parser/excel.js';
import { analyzeColumns, getColumnsByType } from '../wizard/detector.js';

export interface UsersOptions {
  file: string;
  output: string;
  sheet?: string;
}

export async function usersCommand(options: UsersOptions): Promise<void> {
  console.log('\nExtracting user names from Excel...\n');

  // Parse Excel
  const parsed = parseExcel(options.file);
  
  // Determine which sheet to use
  let sheetName = options.sheet;
  if (!sheetName) {
    sheetName = parsed.sheetNames[0];
  }

  const sheet = getSheet(parsed, sheetName);
  if (!sheet) {
    console.error(`Sheet not found: ${sheetName}`);
    process.exit(1);
  }

  console.log(`Analyzing sheet: ${sheet.name}`);

  // Analyze columns to find person-type columns
  const analyses = analyzeColumns(sheet.rows, sheet.headers);
  const personColumns = getColumnsByType(analyses, 'person');

  console.log(`\nFound ${personColumns.length} person column(s):`);
  for (const col of personColumns) {
    console.log(`  - ${col.name} (${col.uniqueCount} unique values)`);
  }

  // Also check for columns with typical person-related names
  const personNamePatterns = ['owner', 'lead', 'manager', 'assignee', 'author', 'member', 'pm', 'dm', 'dri'];
  const additionalCols = analyses.filter(a => 
    !personColumns.includes(a) &&
    personNamePatterns.some(p => a.name.toLowerCase().includes(p))
  );

  if (additionalCols.length > 0) {
    console.log(`\nAdditional columns with person-like names:`);
    for (const col of additionalCols) {
      console.log(`  - ${col.name} (${col.uniqueCount} unique values)`);
    }
  }

  // Collect all unique names
  const allNames = new Set<string>();
  const columnsToScan = [...personColumns, ...additionalCols];

  for (const col of columnsToScan) {
    const values = getUniqueColumnValues(sheet.rows, col.name);
    for (const value of values) {
      // Handle multi-value cells (comma or newline separated)
      const names = value
        .split(/[,\n]/)
        .map(n => n.trim())
        .filter(n => n.length > 0 && n !== 'null' && n !== 'N/A');
      
      for (const name of names) {
        // Skip obvious non-names
        if (name.toLowerCase().includes('deleted') || 
            name.toLowerCase().includes('unassigned') ||
            name.length < 2) {
          continue;
        }
        allNames.add(name);
      }
    }
  }

  console.log(`\nExtracted ${allNames.size} unique user names`);

  // Generate mapping template
  const mapping: Record<string, string> = {
    '_instructions': 'Map Monday.com names to Linear user emails. Use "_skip" to ignore a user. Remove this field before use.',
  };

  const sortedNames = Array.from(allNames).sort();
  for (const name of sortedNames) {
    // Pre-fill obvious patterns
    if (name.toLowerCase().includes('deleted')) {
      mapping[name] = '_skip';
    } else {
      mapping[name] = '';
    }
  }

  // Write output
  const outputPath = resolve(options.output);
  writeFileSync(outputPath, JSON.stringify(mapping, null, 2));

  console.log(`\n✓ User mapping template saved to: ${outputPath}`);
  console.log('\nNext steps:');
  console.log('  1. Open the file and fill in Linear user emails');
  console.log('  2. Use "_skip" for users you don\'t want to map');
  console.log('  3. Remove the "_instructions" field');
  console.log('  4. Run validate to check your config');
}
