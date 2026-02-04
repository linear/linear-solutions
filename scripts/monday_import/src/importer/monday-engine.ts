/**
 * Monday.com-specific import engine
 * Properly handles the hierarchical structure of Monday.com exports
 */

import type { ImportConfig } from '../config/schema.js';
import type { MondayBoard, MondayItem, MondayUpdatesSheet } from '../parser/monday.js';
import type { LinearClientWrapper } from '../linear/client.js';

export interface MondayImportResult {
  success: boolean;
  summary: {
    labelsCreated: number;
    projectsCreated: number;
    issuesCreated: number;
    commentsCreated: number;
    skipped: number;
    failed: number;
  };
  failures: {
    itemName: string;
    error: string;
    row: number;
  }[];
  mapping: Record<string, string>; // monday item name -> linear id
}

/**
 * Run import from parsed Monday.com board
 */
export async function runMondayImport(
  board: MondayBoard,
  config: ImportConfig,
  linearClient: LinearClientWrapper,
  teamId: string,
  dryRun: boolean = false,
): Promise<MondayImportResult> {
  const result: MondayImportResult = {
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

  // Filter to only main items
  const mainItems = board.items.filter(item => item.type === 'mainItem');
  const totalSubitems = board.items.filter(i => i.type === 'subitem').length;
  
  console.log(`\nImporting from: ${board.name}`);
  console.log(`  ${mainItems.length} projects`);
  if (totalSubitems > 0) {
    console.log(`  ${totalSubitems} issues (from subitems)`)
  }

  const importAs = config.dataModel.items.importAs;
  const isProject = importAs === 'project';

  // Phase 1: Prepare labels
  console.log(`\nPhase 1: Preparing labels...`);
  const labelCache = await prepareLabels(mainItems, board, config, linearClient, teamId, dryRun, result);

  // Phase 2: Import main items
  console.log(`\nPhase 2: Importing ${mainItems.length} ${isProject ? 'projects' : 'issues'}...`);

  for (let i = 0; i < mainItems.length; i++) {
    const item = mainItems[i];
    const progress = `[${i + 1}/${mainItems.length}]`;
    
    // Get item name from data
    const nameCol = config.fieldMappings?.project?.name?.source || 
                    config.fieldMappings?.issue?.name?.source ||
                    config.fieldMappings?.issue?.title?.source ||
                    'Name';
    const itemName = item.data[nameCol] || item.data['Name'] || item.data['name'] || `Row ${item.rowNumber}`;
    
    console.log(`${progress} ${truncateDisplay(itemName, 60)}`);

    // Check for duplicates
    if (config.deduplication?.enabled) {
      const isDuplicate = checkDuplicate(itemName, config, linearClient, isProject);
      if (isDuplicate) {
        if (config.deduplication.onDuplicate === 'skip') {
          console.log(`  ⏭ Skipped (duplicate)`);
          result.summary.skipped++;
          continue;
        }
      }
    }

    // Skip empty items
    if (config.options.skipEmpty && (!itemName || itemName === 'Untitled')) {
      console.log(`  ⏭ Skipped (empty)`);
      result.summary.skipped++;
      continue;
    }

    try {
      // Resolve labels for this item
      const labelIds = resolveLabelIds(item, board, config, labelCache, isProject);

      if (dryRun) {
        console.log(`  → Would create ${isProject ? 'project' : 'issue'}: ${itemName}`);
        console.log(`    Group: ${item.group || '(none)'}`);
        console.log(`    Labels: ${labelIds.length}`);
        if (item.subitems && item.subitems.length > 0) {
          console.log(`    Subitems: ${item.subitems.length}`);
          // Count subitems as issues
          for (const subitem of item.subitems) {
            const subitemName = subitem.data['Name'] || subitem.data['name'] || 'Untitled Subitem';
            if (subitemName && subitemName !== 'Untitled Subitem') {
              result.summary.issuesCreated++;
            }
          }
        }
        result.summary[isProject ? 'projectsCreated' : 'issuesCreated']++;
        // Add to mapping for dry-run update matching
        result.mapping[itemName] = `dry-run-${i}`;
        continue;
      }

      // Create the item
      let createdId: string;
      let createdUrl: string;

      if (isProject) {
        const projectData = buildProjectData(item, config, linearClient, teamId);
        const created = await linearClient.createProject({
          ...projectData,
          teamIds: [teamId],
        });
        createdId = created.id;
        createdUrl = created.url;
        result.summary.projectsCreated++;
        
        // Apply labels to project (must be done separately via GraphQL)
        if (labelIds.length > 0) {
          await linearClient.addLabelsToProject(createdId, labelIds);
        }
        
        console.log(`  ✓ Created project: ${createdUrl}`);

        // Create subitems as issues under this project
        if (item.subitems && item.subitems.length > 0) {
          for (const subitem of item.subitems) {
            const subitemName = subitem.data['Name'] || subitem.data['name'] || 'Untitled Subitem';
            if (!subitemName || subitemName === 'Untitled Subitem') continue;
            
            try {
              const subitemData = buildIssueData(subitem, config, linearClient, teamId);
              const subCreated = await linearClient.createIssue({
                ...subitemData,
                title: truncate(subitemName, 255),
                teamId: teamId,
                projectId: createdId,
              });
              console.log(`    ✓ Subitem: ${subCreated.identifier} - ${truncateDisplay(subitemName, 40)}`);
              result.summary.issuesCreated++;
              result.mapping[subitemName] = subCreated.id;
            } catch (subError) {
              console.log(`    ✗ Subitem failed: ${truncateDisplay(subitemName, 40)}`);
            }
          }
        }
      } else {
        const issueData = buildIssueData(item, config, linearClient, teamId);
        const created = await linearClient.createIssue({
          ...issueData,
          teamId: teamId,
          labelIds,
        });
        createdId = created.id;
        createdUrl = created.url;
        result.summary.issuesCreated++;
        
        console.log(`  ✓ Created: ${created.identifier}`);
      }

      result.mapping[itemName] = createdId;

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.log(`  ✗ Error: ${errorMsg}`);
      result.failures.push({
        itemName,
        error: errorMsg,
        row: item.rowNumber,
      });
      result.summary.failed++;
      
      if (!config.options.continueOnError) {
        result.success = false;
        break;
      }
    }
  }

  result.success = result.failures.length === 0;
  return result;
}

/**
 * Prepare all labels needed for the import
 */
async function prepareLabels(
  items: MondayItem[],
  board: MondayBoard,
  config: ImportConfig,
  linearClient: LinearClientWrapper,
  teamId: string,
  dryRun: boolean,
  result: MondayImportResult,
): Promise<Map<string, Map<string, string>>> {
  const labelCache = new Map<string, Map<string, string>>();
  const isProject = config.dataModel.items.importAs === 'project';

  // Process group labels
  if (config.groups?.enabled && board.groups.length > 0) {
    const groupName = config.groups.groupName || 'Board Section';
    const groupValues = new Map<string, string>();
    
    if (dryRun) {
      console.log(`  → Would create label group: ${groupName}`);
      for (const group of board.groups) {
        console.log(`    → Would create label: ${group}`);
        result.summary.labelsCreated++;
      }
    } else {
      try {
        const groupId = isProject
          ? await linearClient.getOrCreateProjectLabelGroup(groupName, teamId)
          : await linearClient.getOrCreateIssueLabelGroup(groupName, teamId);
        result.summary.labelsCreated++;

        for (const group of board.groups) {
          try {
            const labelId = isProject
              ? await linearClient.getOrCreateProjectLabel(group, groupId, teamId)
              : await linearClient.getOrCreateIssueLabel(group, groupId, teamId);
            groupValues.set(group, labelId);
            groupValues.set(group.toLowerCase(), labelId);
            result.summary.labelsCreated++;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.log(`    ✗ Failed to create label: ${group}`);
            console.log(`      ${msg}`);
            if (!config.options.continueOnError) throw e;
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log(`  ✗ Failed to create label group: ${groupName}`);
        console.log(`    ${msg}`);
        if (!config.options.continueOnError) throw e;
      }
    }
    
    labelCache.set('_group', groupValues);
  }

  // Process label configs
  for (const labelConfig of config.labels || []) {
    const column = labelConfig.sourceColumn;
    const valueCache = new Map<string, string>();
    
    // Collect unique values from items
    const uniqueValues = new Set<string>();
    for (const item of items) {
      const value = item.data[column];
      if (value) {
        if (labelConfig.delimiter) {
          value.split(labelConfig.delimiter).forEach(v => {
            const trimmed = v.trim();
            if (trimmed) uniqueValues.add(trimmed);
          });
        } else {
          uniqueValues.add(value.trim());
        }
      }
    }

    if (uniqueValues.size === 0) continue;

    const groupNameForLabel = labelConfig.groupName || column;
    const isFlat = labelConfig.flat;

    if (dryRun) {
      if (!isFlat) {
        console.log(`  → Would create label group: ${groupNameForLabel}`);
      }
      for (const value of uniqueValues) {
        const displayName = labelConfig.valueMapping?.[value] || value;
        console.log(`    → Would create label: ${displayName}`);
        result.summary.labelsCreated++;
      }
    } else {
      let groupId: string | undefined;
      
      if (!isFlat) {
        try {
          groupId = isProject
            ? await linearClient.getOrCreateProjectLabelGroup(groupNameForLabel, teamId)
            : await linearClient.getOrCreateIssueLabelGroup(groupNameForLabel, teamId);
          result.summary.labelsCreated++;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.log(`  ✗ Failed to create label group: ${groupNameForLabel}`);
          console.log(`    ${msg}`);
          if (!config.options.continueOnError) throw e;
          continue;
        }
      }

      for (const value of uniqueValues) {
        const displayName = labelConfig.valueMapping?.[value] || value;
        try {
          const labelId = isProject
            ? await linearClient.getOrCreateProjectLabel(displayName, groupId, teamId)
            : await linearClient.getOrCreateIssueLabel(displayName, groupId, teamId);
          valueCache.set(value, labelId);
          valueCache.set(value.toLowerCase(), labelId);
          result.summary.labelsCreated++;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.log(`    ✗ Failed to create label: ${displayName}`);
          console.log(`      ${msg}`);
          if (!config.options.continueOnError) throw e;
        }
      }
    }

    labelCache.set(column, valueCache);
  }

  return labelCache;
}

/**
 * Resolve label IDs for an item
 */
function resolveLabelIds(
  item: MondayItem,
  board: MondayBoard,
  config: ImportConfig,
  labelCache: Map<string, Map<string, string>>,
  isProject: boolean,
): string[] {
  const labelIds: string[] = [];

  // Group label
  if (config.groups?.enabled && item.group) {
    const groupValues = labelCache.get('_group');
    if (groupValues) {
      const labelId = groupValues.get(item.group) || groupValues.get(item.group.toLowerCase());
      if (labelId) labelIds.push(labelId);
    }
  }

  // Label columns
  for (const labelConfig of config.labels || []) {
    const column = labelConfig.sourceColumn;
    const valueCache = labelCache.get(column);
    if (!valueCache) continue;

    const value = item.data[column];
    if (!value) continue;

    if (labelConfig.delimiter) {
      for (const v of value.split(labelConfig.delimiter)) {
        const trimmed = v.trim();
        const labelId = valueCache.get(trimmed) || valueCache.get(trimmed.toLowerCase());
        if (labelId) labelIds.push(labelId);
      }
    } else {
      const labelId = valueCache.get(value.trim()) || valueCache.get(value.trim().toLowerCase());
      if (labelId) labelIds.push(labelId);
    }
  }

  return labelIds;
}

/**
 * Build project data from Monday item
 */
function buildProjectData(
  item: MondayItem,
  config: ImportConfig,
  linearClient: LinearClientWrapper,
  teamId: string,
): {
  name: string;
  description?: string;
  statusId?: string;
  priority?: number;
  startDate?: string;
  targetDate?: string;
  leadId?: string;
} {
  const mappings = config.fieldMappings?.project || {};
  
  const getName = () => {
    if (mappings.name?.source) {
      return item.data[mappings.name.source] || 'Untitled';
    }
    return item.data['Name'] || item.data['name'] || 'Untitled';
  };

  const getDescription = () => {
    if (mappings.description?.template && mappings.description?.sources) {
      let desc = mappings.description.template;
      for (const source of mappings.description.sources) {
        const value = item.data[source] || '';
        desc = desc.replace(new RegExp(`\\{\\{${source}\\}\\}`, 'g'), value);
      }
      return desc.trim() || undefined;
    }
    if (mappings.description?.source) {
      return item.data[mappings.description.source] || undefined;
    }
    return undefined;
  };

  const getStatus = () => {
    if (mappings.state?.source) {
      const rawStatus = item.data[mappings.state.source];
      if (rawStatus) {
        const mappedStatus = config.statusMapping[rawStatus] || config.statusMapping['_default'] || rawStatus;
        return linearClient.resolveProjectStatusId(mappedStatus);
      }
    }
    return undefined;
  };

  const getPriority = () => {
    if (mappings.priority?.source) {
      const rawPriority = item.data[mappings.priority.source];
      if (rawPriority) {
        return config.priorityMapping[rawPriority] ?? config.priorityMapping['_default'] ?? undefined;
      }
    }
    return undefined;
  };

  const getDate = (mapping: typeof mappings.startDate) => {
    if (!mapping?.source) return undefined;
    const value = item.data[mapping.source];
    if (!value) return undefined;
    
    // Handle timeline columns (date range) - these come as strings
    if (mapping.transform === 'timelineStart' && typeof value === 'string') {
      const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
      return match ? match[1] : undefined;
    }
    if (mapping.transform === 'timelineEnd' && typeof value === 'string') {
      const match = value.match(/(\d{4}-\d{2}-\d{2})$/);
      return match ? match[1] : undefined;
    }
    
    // Already in ISO format
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return value;
    }
    
    // Excel serial date (number of days since Dec 30, 1899)
    if (typeof value === 'number' && value > 0 && value < 100000) {
      const date = new Date((value - 25569) * 86400 * 1000);
      if (!isNaN(date.getTime())) {
        return date.toISOString().split('T')[0];
      }
    }
    
    // Try parsing as date string
    if (typeof value === 'string') {
      const date = new Date(value);
      if (!isNaN(date.getTime()) && date.getFullYear() > 1900 && date.getFullYear() < 2100) {
        return date.toISOString().split('T')[0];
      }
    }
    
    return undefined;
  };

  const getLead = () => {
    if (mappings.lead?.source) {
      const rawLead = item.data[mappings.lead.source];
      if (rawLead) {
        return linearClient.resolveUserId(rawLead);
      }
    }
    return undefined;
  };

  return {
    name: truncate(getName(), 255),
    description: getDescription(),
    statusId: getStatus() || undefined,
    priority: getPriority(),
    startDate: getDate(mappings.startDate),
    targetDate: getDate(mappings.targetDate),
    leadId: getLead() || undefined,
  };
}

/**
 * Build issue data from Monday item
 */
function buildIssueData(
  item: MondayItem,
  config: ImportConfig,
  linearClient: LinearClientWrapper,
  teamId: string,
): {
  title: string;
  description?: string;
  stateId?: string;
  assigneeId?: string;
  priority?: number;
  estimate?: number;
  dueDate?: string;
} {
  const mappings = config.fieldMappings?.issue || {};
  
  const getTitle = () => {
    if (mappings.title?.source || mappings.name?.source) {
      const source = mappings.title?.source || mappings.name?.source;
      return item.data[source!] || 'Untitled';
    }
    return item.data['Name'] || item.data['name'] || 'Untitled';
  };

  const getDescription = () => {
    if (mappings.description?.template && mappings.description?.sources) {
      let desc = mappings.description.template;
      for (const source of mappings.description.sources) {
        const value = item.data[source] || '';
        desc = desc.replace(new RegExp(`\\{\\{${source}\\}\\}`, 'g'), value);
      }
      return desc.trim() || undefined;
    }
    if (mappings.description?.source) {
      return item.data[mappings.description.source] || undefined;
    }
    return undefined;
  };

  const getState = () => {
    const stateMapping = mappings.state;
    if (stateMapping?.source) {
      const rawState = item.data[stateMapping.source];
      if (rawState) {
        // Use issueStatusMapping if available, otherwise fall back to statusMapping
        const statusMap = config.issueStatusMapping || config.statusMapping;
        const mappedState = statusMap[rawState] || statusMap['_default'] || rawState;
        return linearClient.resolveIssueStateId(mappedState);
      }
    }
    return undefined;
  };

  const getDueDate = () => {
    if (!mappings.dueDate?.source) return undefined;
    const value = item.data[mappings.dueDate.source];
    if (!value) return undefined;
    
    // Already in ISO format
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return value;
    }
    
    // Excel serial date (number of days since Dec 30, 1899)
    // Excel uses 25569 as the offset to Unix epoch (Jan 1, 1970)
    if (typeof value === 'number' && value > 0 && value < 100000) {
      const date = new Date((value - 25569) * 86400 * 1000);
      if (!isNaN(date.getTime())) {
        return date.toISOString().split('T')[0];
      }
    }
    
    // Try parsing as date string
    if (typeof value === 'string') {
      const date = new Date(value);
      if (!isNaN(date.getTime()) && date.getFullYear() > 1900 && date.getFullYear() < 2100) {
        return date.toISOString().split('T')[0];
      }
    }
    
    return undefined;
  };

  return {
    title: truncate(getTitle(), 255),
    description: getDescription(),
    stateId: getState() || undefined,
    assigneeId: mappings.assignee?.source ? linearClient.resolveUserId(item.data[mappings.assignee.source]) || undefined : undefined,
    priority: undefined, // TODO
    estimate: mappings.estimate?.source ? parseFloat(item.data[mappings.estimate.source] || '') || undefined : undefined,
    dueDate: getDueDate(),
  };
}

/**
 * Check if item is a duplicate
 */
function checkDuplicate(
  itemName: string,
  config: ImportConfig,
  linearClient: LinearClientWrapper,
  isProject: boolean,
): boolean {
  const workspace = linearClient.getWorkspace();
  if (!workspace) return false;

  if (isProject) {
    return workspace.existingProjects.has(itemName.toLowerCase().trim());
  } else {
    // For issues, check across all projects
    for (const titles of workspace.existingIssues.values()) {
      if (titles.has(itemName.toLowerCase().trim())) {
        return true;
      }
    }
    return false;
  }
}

/**
 * Import updates as comments
 */
export async function importMondayUpdates(
  updates: MondayUpdatesSheet,
  config: ImportConfig,
  linearClient: LinearClientWrapper,
  itemMapping: Record<string, string>,
  dryRun: boolean,
  result: MondayImportResult,
): Promise<void> {
  if (!config.updates?.enabled) return;
  if (updates.updates.length === 0) {
    console.log(`\nNo updates to import.`);
    return;
  }

  console.log(`\nPhase 3: Importing ${updates.updates.length} updates...`);

  const contentCol = config.updates.contentColumn || 'Update';
  const linkCol = config.updates.linkColumn || 'Item';
  const dateCol = config.updates.dateColumn;
  const authorCol = config.updates.authorColumn;

  for (const update of updates.updates) {
    const content = update.data[contentCol];
    const linkedItem = update.data[linkCol];
    
    if (!content || !linkedItem) continue;

    // Find the Linear item ID
    let linearId = itemMapping[linkedItem];
    if (!linearId) {
      // Try lowercase match
      linearId = itemMapping[linkedItem.toLowerCase()];
    }
    if (!linearId) {
      // Try partial match
      for (const [name, id] of Object.entries(itemMapping)) {
        if (name.toLowerCase().includes(linkedItem.toLowerCase()) ||
            linkedItem.toLowerCase().includes(name.toLowerCase())) {
          linearId = id;
          break;
        }
      }
    }

    if (!linearId) {
      console.log(`  ⏭ Update skipped - item not found: ${truncateDisplay(linkedItem, 40)}`);
      continue;
    }

    // Build comment body
    let body = content;
    if (dateCol && update.data[dateCol]) {
      body = `*${update.data[dateCol]}*\n\n${body}`;
    }
    if (authorCol && update.data[authorCol]) {
      body = `[From ${update.data[authorCol]}]\n\n${body}`;
    }

    if (dryRun) {
      console.log(`  → Would add update to: ${truncateDisplay(linkedItem, 40)}`);
      result.summary.commentsCreated++;
      continue;
    }

    try {
      const isProject = config.dataModel.items.importAs === 'project';
      if (isProject) {
        await linearClient.createProjectUpdate({
          projectId: linearId,
          body,
        });
      } else {
        await linearClient.createComment(linearId, body);
      }
      console.log(`  ✓ Added update to: ${truncateDisplay(linkedItem, 40)}`);
      result.summary.commentsCreated++;
    } catch (e) {
      console.log(`  ✗ Failed to add update to: ${truncateDisplay(linkedItem, 40)}`);
    }
  }
}

/**
 * Truncate string to max length
 */
function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength - 3) + '...';
}

/**
 * Truncate string for display
 */
function truncateDisplay(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength - 3) + '...';
}
