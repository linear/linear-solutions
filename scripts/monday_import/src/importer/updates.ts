/**
 * Updates/comments importer
 */

import type { ImportConfig } from '../config/schema.js';
import type { ParsedSheet, ParsedRow } from '../parser/excel.js';
import { getCellString, parseDate } from '../parser/excel.js';
import type { LinearClientWrapper } from '../linear/client.js';
import type { ImportResult } from './engine.js';

interface Update {
  itemName: string;
  content: string;
  author?: string;
  date?: string;
  rowNumber: number;
}

/**
 * Import updates/comments from the updates sheet
 */
export async function importUpdates(
  updatesSheet: ParsedSheet,
  config: ImportConfig,
  linearClient: LinearClientWrapper,
  itemMapping: Record<string, string>, // mondayId/name -> linearId
  dryRun: boolean,
  result: ImportResult,
): Promise<void> {
  if (!config.updates?.enabled) return;

  const updatesConfig = config.updates;
  
  // Parse updates
  const updates: Update[] = [];
  
  for (const row of updatesSheet.rows) {
    const itemName = getCellString(row, updatesConfig.linkColumn || '');
    const content = getCellString(row, updatesConfig.contentColumn || '');
    
    if (!itemName || !content) continue;
    
    const author = updatesConfig.authorColumn 
      ? getCellString(row, updatesConfig.authorColumn) 
      : undefined;
    const dateStr = updatesConfig.dateColumn 
      ? getCellString(row, updatesConfig.dateColumn) 
      : undefined;
    const date = dateStr ? parseDate(dateStr) : undefined;
    
    updates.push({
      itemName,
      content,
      author: author || undefined,
      date: date || undefined,
      rowNumber: row._rowNumber,
    });
  }

  // Sort by date
  if (updatesConfig.sortOrder === 'asc') {
    updates.sort((a, b) => {
      if (!a.date && !b.date) return 0;
      if (!a.date) return 1;
      if (!b.date) return -1;
      return a.date.localeCompare(b.date);
    });
  } else {
    updates.sort((a, b) => {
      if (!a.date && !b.date) return 0;
      if (!a.date) return -1;
      if (!b.date) return 1;
      return b.date.localeCompare(a.date);
    });
  }

  console.log(`\nPhase 4: Importing ${updates.length} updates...`);

  const importAs = config.dataModel.items.importAs;
  const isProject = importAs === 'project';

  for (const update of updates) {
    // Find the Linear item
    let linearId = itemMapping[update.itemName];
    
    // Try lowercase match
    if (!linearId) {
      linearId = itemMapping[update.itemName.toLowerCase()];
    }
    
    // Try partial match
    if (!linearId) {
      for (const [key, id] of Object.entries(itemMapping)) {
        if (key.toLowerCase().includes(update.itemName.toLowerCase()) ||
            update.itemName.toLowerCase().includes(key.toLowerCase())) {
          linearId = id;
          break;
        }
      }
    }

    if (!linearId) {
      console.log(`  ⏭ Update skipped - item not found: ${update.itemName}`);
      continue;
    }

    // Format the comment body
    let body = update.content;
    
    // Handle author fallback
    if (update.author) {
      const userId = linearClient.resolveUserId(update.author);
      if (!userId && updatesConfig.authorFallback !== 'skip') {
        const authorPrefix = `[Originally by ${update.author}] `;
        
        if (updatesConfig.authorFallback === 'prepend') {
          body = authorPrefix + body;
        } else {
          body = body + '\n\n' + authorPrefix;
        }
      }
    }

    // Add date if present
    if (update.date) {
      body = `*${update.date}*\n\n${body}`;
    }

    if (dryRun) {
      console.log(`  → Would add update to: ${update.itemName}`);
      continue;
    }

    try {
      if (isProject) {
        // For projects, create a project update
        await linearClient.createProjectUpdate({
          projectId: linearId,
          body: body,
        });
      } else {
        // For issues, create a comment
        await linearClient.createComment(linearId, body);
      }
      console.log(`  ✓ Added update to: ${update.itemName}`);
      result.summary.commentsCreated++;
    } catch (error) {
      console.log(`  ✗ Failed to add update to: ${update.itemName}`);
    }
  }
}
