/**
 * Main import engine - orchestrates the import process
 */

import type { ImportConfig } from '../config/schema.js';
import type { ParsedSheet, ParsedRow } from '../parser/excel.js';
import { getCellString, getCellBoolean, parseMultiValue } from '../parser/excel.js';
import type { LinearClientWrapper } from '../linear/client.js';
import { transformRow, type TransformedProject, type TransformedIssue } from '../transformer/engine.js';

export interface ImportResult {
  success: boolean;
  summary: {
    labelsCreated: number;
    projectsCreated: number;
    issuesCreated: number;
    commentsCreated: number;
    skipped: number;
    failed: number;
  };
  failures: FailureRecord[];
  mapping: Record<string, string>; // mondayId -> linearId
}

export interface FailureRecord {
  mondayId?: string;
  itemName: string;
  error: string;
  row: number;
}

/**
 * Run the import process
 */
export async function runImport(
  sheet: ParsedSheet,
  config: ImportConfig,
  linearClient: LinearClientWrapper,
  teamId: string,
  dryRun: boolean = false,
): Promise<ImportResult> {
  const result: ImportResult = {
    success: true,
    summary: {
      labelsCreated: 0,
      projectsCreated: 0,
      issuesCreated: 0,
      commentsCreated: 0,
      skipped: 0,
      failed: 0,
    },
    failures: [],
    mapping: {},
  };

  const importAs = config.dataModel.items.importAs;
  const isProject = importAs === 'project';

  console.log(`\nPhase 1: Preparing labels...`);
  
  // Phase 1: Collect and create all labels
  const labelCache = await prepareLabels(sheet.rows, config, linearClient, teamId, dryRun, result);

  console.log(`\nPhase 2: Importing ${sheet.rows.length} items as ${importAs}s...`);

  // Phase 2: Import items
  const createdItems: Map<string, string> = new Map(); // name -> linearId
  
  for (let i = 0; i < sheet.rows.length; i++) {
    const row = sheet.rows[i];
    const progress = `[${i + 1}/${sheet.rows.length}]`;
    
    try {
      // Resolve labels for this row
      const rowLabels = resolveLabelsForRow(row, config, labelCache, isProject);
      
      // Transform the row
      const item = transformRow(row, config, linearClient, rowLabels);
      const itemName = isProject ? (item as TransformedProject).name : (item as TransformedIssue).title;
      
      console.log(`${progress} ${truncateDisplay(itemName, 50)}`);

      // Check for duplicates
      if (config.deduplication?.enabled) {
        const isDuplicate = await checkDuplicate(item, config, linearClient, teamId);
        if (isDuplicate) {
          if (config.deduplication.onDuplicate === 'skip') {
            console.log(`  ⏭ Skipped (duplicate)`);
            result.summary.skipped++;
            continue;
          }
          // TODO: Handle 'update' case
        }
      }

      if (dryRun) {
        console.log(`  → Would create ${importAs}`);
        if (isProject) {
          const project = item as TransformedProject;
          console.log(`    Status: ${project.statusId ? 'set' : 'none'}, Priority: ${project.priority ?? 'none'}`);
          console.log(`    Lead: ${project.leadId ? 'set' : 'none'}, Labels: ${project.labelIds.length}`);
          if (project.subitems?.length) {
            console.log(`    Subitems: ${project.subitems.length}`);
          }
        }
        result.summary[isProject ? 'projectsCreated' : 'issuesCreated']++;
        continue;
      }

      // Create the item
      if (isProject) {
        const project = item as TransformedProject;
        // Note: Projects don't support labelIds via SDK, labels would need to be added via GraphQL
        const created = await linearClient.createProject({
          name: project.name,
          description: project.description,
          teamIds: [teamId],
          statusId: project.statusId,
          priority: project.priority,
          startDate: project.startDate,
          targetDate: project.targetDate,
          leadId: project.leadId,
        });

        console.log(`  ✓ Created: ${created.url}`);
        result.summary.projectsCreated++;
        result.mapping[project.mondayId || project.name] = created.id;
        createdItems.set(project.name.toLowerCase(), created.id);

        // Create subitems as issues
        if (project.subitems && project.subitems.length > 0) {
          for (const subitem of project.subitems) {
            try {
              const subCreated = await linearClient.createIssue({
                title: subitem.title,
                teamId: teamId,
                projectId: created.id,
                labelIds: subitem.labelIds,
              });
              console.log(`    ✓ Subitem: ${subCreated.identifier}`);
              result.summary.issuesCreated++;
            } catch (subError) {
              console.log(`    ✗ Subitem failed: ${subitem.title}`);
            }
          }
        }

        // Create link attachments (projects don't have attachments, add to description)
        // Links are typically added during issue creation

      } else {
        const issue = item as TransformedIssue;
        const created = await linearClient.createIssue({
          title: issue.title,
          description: issue.description,
          teamId: teamId,
          stateId: issue.stateId,
          assigneeId: issue.assigneeId,
          priority: issue.priority,
          estimate: issue.estimate,
          labelIds: issue.labelIds,
          dueDate: issue.dueDate,
        });

        console.log(`  ✓ Created: ${created.identifier}`);
        result.summary.issuesCreated++;
        result.mapping[issue.mondayId || issue.title] = created.id;
        createdItems.set(issue.title.toLowerCase(), created.id);

        // Create link attachments
        if (issue.links) {
          for (const link of issue.links) {
            try {
              await linearClient.createAttachment(created.id, link.url, link.title);
            } catch (linkError) {
              // Ignore link errors
            }
          }
        }
      }

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.log(`  ✗ Error: ${errorMsg}`);
      result.failures.push({
        mondayId: getCellString(row, config.source.identifierColumn || '') || undefined,
        itemName: getCellString(row, config.fieldMappings?.project?.name?.source || 
                                     config.fieldMappings?.issue?.name?.source ||
                                     config.fieldMappings?.issue?.title?.source || 'Name') || 'Unknown',
        error: errorMsg,
        row: row._rowNumber,
      });
      result.summary.failed++;
      
      if (!config.options.continueOnError) {
        result.success = false;
        break;
      }
    }
  }

  // Phase 3: Dependencies (second pass)
  if (config.dependencies?.enabled && !dryRun) {
    console.log(`\nPhase 3: Creating dependencies...`);
    await createDependencies(sheet.rows, config, linearClient, createdItems, result);
  }

  result.success = result.failures.length === 0;
  return result;
}

/**
 * Prepare all labels needed for the import
 */
async function prepareLabels(
  rows: ParsedRow[],
  config: ImportConfig,
  linearClient: LinearClientWrapper,
  teamId: string,
  dryRun: boolean,
  result: ImportResult,
): Promise<Map<string, Map<string, string>>> { // column -> value -> labelId
  const labelCache = new Map<string, Map<string, string>>();
  const isProject = config.dataModel.items.importAs === 'project';

  // Process label configs
  for (const labelConfig of config.labels || []) {
    const column = labelConfig.sourceColumn;
    const valueCache = new Map<string, string>();
    
    // Collect unique values
    const uniqueValues = new Set<string>();
    for (const row of rows) {
      const value = getCellString(row, column);
      if (value) {
        if (labelConfig.delimiter) {
          parseMultiValue(value, labelConfig.delimiter).forEach(v => uniqueValues.add(v));
        } else {
          uniqueValues.add(value);
        }
      }
    }

    if (uniqueValues.size === 0) continue;

    const groupName = labelConfig.groupName || column;
    const isFlat = labelConfig.flat;

    if (dryRun) {
      if (!isFlat) {
        console.log(`  → Would create label group: ${groupName}`);
      }
      for (const value of uniqueValues) {
        const displayName = labelConfig.valueMapping?.[value] || value;
        console.log(`    → Would create label: ${displayName}`);
        result.summary.labelsCreated++;
      }
    } else {
      let groupId: string | undefined;
      
      // Create group if needed
      if (!isFlat) {
        try {
          if (isProject) {
            groupId = await linearClient.getOrCreateProjectLabelGroup(groupName);
          } else {
            groupId = await linearClient.getOrCreateIssueLabelGroup(groupName, teamId);
          }
          result.summary.labelsCreated++;
        } catch (error) {
          console.log(`  ✗ Failed to create label group: ${groupName}`);
          continue;
        }
      }

      // Create labels
      for (const value of uniqueValues) {
        const displayName = labelConfig.valueMapping?.[value] || value;
        try {
          let labelId: string;
          if (isProject) {
            labelId = await linearClient.getOrCreateProjectLabel(displayName, groupId);
          } else {
            labelId = await linearClient.getOrCreateIssueLabel(displayName, groupId, teamId);
          }
          valueCache.set(value, labelId);
          result.summary.labelsCreated++;
        } catch (error) {
          console.log(`  ✗ Failed to create label: ${displayName}`);
        }
      }
    }

    labelCache.set(column, valueCache);
  }

  // Process group labels (board sections)
  if (config.groups?.enabled) {
    const groupColumn = config.groups.sourceColumn;
    const groupName = config.groups.groupName || 'Board Section';
    const valueCache = new Map<string, string>();

    const uniqueGroups = new Set<string>();
    for (const row of rows) {
      const value = getCellString(row, groupColumn);
      if (value) uniqueGroups.add(value);
    }

    if (uniqueGroups.size > 0) {
      if (dryRun) {
        console.log(`  → Would create label group: ${groupName}`);
        for (const value of uniqueGroups) {
          console.log(`    → Would create label: ${value}`);
        }
      } else {
        let groupId: string;
        if (isProject) {
          groupId = await linearClient.getOrCreateProjectLabelGroup(groupName);
        } else {
          groupId = await linearClient.getOrCreateIssueLabelGroup(groupName, teamId);
        }

        for (const value of uniqueGroups) {
          try {
            let labelId: string;
            if (isProject) {
              labelId = await linearClient.getOrCreateProjectLabel(value, groupId);
            } else {
              labelId = await linearClient.getOrCreateIssueLabel(value, groupId, teamId);
            }
            valueCache.set(value, labelId);
          } catch (error) {
            // Ignore
          }
        }
      }
      labelCache.set(groupColumn, valueCache);
    }
  }

  // Process checkbox labels
  for (const checkboxConfig of config.checkboxes || []) {
    const column = checkboxConfig.sourceColumn;
    const labelName = checkboxConfig.labelWhenChecked;
    
    // Check if any row has this checked
    const hasChecked = rows.some(row => getCellBoolean(row, column));
    
    if (hasChecked) {
      if (dryRun) {
        console.log(`  → Would create label: ${labelName}`);
      } else {
        try {
          let labelId: string;
          if (isProject) {
            labelId = await linearClient.getOrCreateProjectLabel(labelName);
          } else {
            labelId = await linearClient.getOrCreateIssueLabel(labelName, undefined, teamId);
          }
          const valueCache = new Map<string, string>();
          valueCache.set('checked', labelId);
          labelCache.set(`_checkbox_${column}`, valueCache);
        } catch (error) {
          // Ignore
        }
      }
    }
  }

  return labelCache;
}

/**
 * Resolve labels for a specific row
 */
function resolveLabelsForRow(
  row: ParsedRow,
  config: ImportConfig,
  labelCache: Map<string, Map<string, string>>,
  isProject: boolean,
): Map<string, string[]> {
  const rowLabels = new Map<string, string[]>();

  // Regular label columns
  for (const labelConfig of config.labels || []) {
    const column = labelConfig.sourceColumn;
    const valueCache = labelCache.get(column);
    if (!valueCache) continue;

    const labelIds: string[] = [];
    const value = getCellString(row, column);
    
    if (value) {
      if (labelConfig.delimiter) {
        for (const v of parseMultiValue(value, labelConfig.delimiter)) {
          const labelId = valueCache.get(v);
          if (labelId) labelIds.push(labelId);
        }
      } else {
        const labelId = valueCache.get(value);
        if (labelId) labelIds.push(labelId);
      }
    }

    if (labelIds.length > 0) {
      rowLabels.set(column, labelIds);
    }
  }

  // Group labels
  if (config.groups?.enabled) {
    const groupColumn = config.groups.sourceColumn;
    const valueCache = labelCache.get(groupColumn);
    if (valueCache) {
      const value = getCellString(row, groupColumn);
      if (value) {
        const labelId = valueCache.get(value);
        if (labelId) {
          rowLabels.set(groupColumn, [labelId]);
        }
      }
    }
  }

  // Checkbox labels
  for (const checkboxConfig of config.checkboxes || []) {
    const column = checkboxConfig.sourceColumn;
    const isChecked = getCellBoolean(row, column);
    
    if (isChecked) {
      const valueCache = labelCache.get(`_checkbox_${column}`);
      if (valueCache) {
        const labelId = valueCache.get('checked');
        if (labelId) {
          rowLabels.set(`_checkbox_${column}`, [labelId]);
        }
      }
    }
  }

  return rowLabels;
}

/**
 * Check if an item is a duplicate
 */
async function checkDuplicate(
  item: TransformedProject | TransformedIssue,
  config: ImportConfig,
  linearClient: LinearClientWrapper,
  teamId: string,
): Promise<boolean> {
  const workspace = linearClient.getWorkspace();
  if (!workspace) return false;

  const name = item.type === 'project' 
    ? (item as TransformedProject).name 
    : (item as TransformedIssue).title;

  if (item.type === 'project') {
    return workspace.existingProjects.has(name.toLowerCase().trim());
  } else {
    // For issues, check by project (if any) + title
    const existingInProject = workspace.existingIssues.get('_none') || new Set();
    return existingInProject.has(name.toLowerCase().trim());
  }
}

/**
 * Create dependencies between items
 */
async function createDependencies(
  rows: ParsedRow[],
  config: ImportConfig,
  linearClient: LinearClientWrapper,
  createdItems: Map<string, string>, // name -> linearId
  result: ImportResult,
): Promise<void> {
  if (!config.dependencies?.enabled) return;

  for (const row of rows) {
    const itemName = getCellString(row, config.fieldMappings?.project?.name?.source ||
                                        config.fieldMappings?.issue?.name?.source ||
                                        config.fieldMappings?.issue?.title?.source || 'Name');
    
    if (!itemName) continue;
    
    const itemId = createdItems.get(itemName.toLowerCase());
    if (!itemId) continue;

    // Process "blocks" column
    if (config.dependencies.blocksColumn) {
      const blocksValue = getCellString(row, config.dependencies.blocksColumn);
      if (blocksValue) {
        const blockedNames = parseMultiValue(blocksValue, ',');
        for (const blockedName of blockedNames) {
          const blockedId = createdItems.get(blockedName.toLowerCase().trim());
          if (blockedId) {
            try {
              await linearClient.createIssueRelation(itemId, blockedId, 'blocks');
              console.log(`  ✓ ${truncateDisplay(itemName, 30)} blocks ${truncateDisplay(blockedName, 30)}`);
            } catch (error) {
              // Ignore dependency errors
            }
          }
        }
      }
    }

    // Process "blocked by" column
    if (config.dependencies.blockedByColumn) {
      const blockedByValue = getCellString(row, config.dependencies.blockedByColumn);
      if (blockedByValue) {
        const blockerNames = parseMultiValue(blockedByValue, ',');
        for (const blockerName of blockerNames) {
          const blockerId = createdItems.get(blockerName.toLowerCase().trim());
          if (blockerId) {
            try {
              await linearClient.createIssueRelation(blockerId, itemId, 'blocks');
              console.log(`  ✓ ${truncateDisplay(blockerName, 30)} blocks ${truncateDisplay(itemName, 30)}`);
            } catch (error) {
              // Ignore dependency errors
            }
          }
        }
      }
    }
  }
}

/**
 * Truncate string for display
 */
function truncateDisplay(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength - 3) + '...';
}
