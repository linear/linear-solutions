/**
 * Validate command - validate config against Excel
 */

import { loadConfig } from '../config/loader.js';
import { validateConfigAgainstExcel } from '../config/validator.js';
import { parseExcel, getSheet } from '../parser/excel.js';

export interface ValidateOptions {
  config: string;
  file: string;
}

export async function validateCommand(options: ValidateOptions): Promise<void> {
  console.log('\nValidating configuration...\n');

  // Load config
  const { config, validation } = loadConfig(options.config);
  
  if (validation.errors.length > 0) {
    console.log('❌ Configuration errors:');
    for (const error of validation.errors) {
      console.log(`  - ${error.path}: ${error.message}`);
    }
  }

  if (validation.warnings.length > 0) {
    console.log('⚠️  Configuration warnings:');
    for (const warning of validation.warnings) {
      console.log(`  - ${warning.path}: ${warning.message}`);
    }
  }

  if (!config) {
    console.log('\n❌ Configuration is invalid. Fix errors above and try again.');
    process.exit(1);
  }

  console.log('✓ Configuration structure is valid\n');

  // Parse Excel
  console.log('Checking Excel file...\n');
  const parsed = parseExcel(options.file);
  
  console.log(`Found ${parsed.sheetNames.length} sheet(s): ${parsed.sheetNames.join(', ')}`);

  // Check items sheet
  const itemsSheet = getSheet(parsed, config.source.sheets.items);
  if (!itemsSheet) {
    console.log(`\n❌ Items sheet not found: ${config.source.sheets.items}`);
    process.exit(1);
  }
  console.log(`✓ Items sheet found: ${itemsSheet.name} (${itemsSheet.rows.length} rows)`);

  // Check updates sheet if configured
  if (config.source.sheets.updates) {
    const updatesSheet = getSheet(parsed, config.source.sheets.updates);
    if (!updatesSheet) {
      console.log(`⚠️  Updates sheet not found: ${config.source.sheets.updates}`);
    } else {
      console.log(`✓ Updates sheet found: ${updatesSheet.name} (${updatesSheet.rows.length} rows)`);
    }
  }

  // Validate column mappings
  console.log('\nValidating column mappings...\n');
  const columnValidation = validateConfigAgainstExcel(config, itemsSheet.headers);

  if (columnValidation.errors.length > 0) {
    console.log('❌ Column mapping errors:');
    for (const error of columnValidation.errors) {
      console.log(`  - ${error.path}: ${error.message}`);
    }
  }

  if (columnValidation.warnings.length > 0) {
    console.log('⚠️  Column mapping warnings:');
    for (const warning of columnValidation.warnings) {
      console.log(`  - ${warning.path}: ${warning.message}`);
    }
  }

  if (columnValidation.valid && validation.valid) {
    console.log('✓ All column mappings are valid\n');
    console.log('='.repeat(40));
    console.log('✓ Configuration is valid and ready to use!');
    console.log('='.repeat(40));
    console.log('\nNext steps:');
    console.log('  1. Run: npx monday-import dry-run -c <config> -f <excel>');
    console.log('  2. Review the dry run output');
    console.log('  3. Run: npx monday-import run -c <config> -f <excel>');
  } else {
    console.log('\n❌ Validation failed. Fix errors above and try again.');
    process.exit(1);
  }
}
