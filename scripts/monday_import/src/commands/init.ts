/**
 * Init command - interactive wizard to generate config
 */

import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { select, input, checkbox, confirm } from '@inquirer/prompts';
import { parseMondayExport, getBoardSummary, columnIndexToLetter, formatColumn } from '../parser/monday.js';
import type { MondayBoard } from '../parser/monday.js';
import type {
  ImportConfig,
  FieldMapping,
  TransformType,
  CustomIssueStateDef,
  CustomProjectStatusDef,
  IssueStateType,
  ProjectStatusType,
} from '../config/schema.js';

const CUSTOM_STATUS_SENTINEL = '__custom__';
const ISSUE_STATE_TYPES: IssueStateType[] = ['backlog', 'unstarted', 'started', 'completed', 'canceled'];
const PROJECT_STATUS_TYPES: ProjectStatusType[] = ['backlog', 'planned', 'started', 'paused', 'completed', 'canceled'];

function dedupeByName<T extends { name: string }>(defs: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const d of defs) {
    if (seen.has(d.name)) continue;
    seen.add(d.name);
    out.push(d);
  }
  return out;
}

async function promptCustomStatus<T extends IssueStateType | ProjectStatusType>(
  sourceStatus: string,
  kind: 'issue' | 'project',
): Promise<{ name: string; type: T; color?: string }> {
  const name = (await input({
    message: `  New Linear ${kind} status name for "${sourceStatus}":`,
    validate: (v) => v.trim().length > 0 || 'Name is required',
  })).trim();

  const typeChoices = (kind === 'issue' ? ISSUE_STATE_TYPES : PROJECT_STATUS_TYPES)
    .map((t) => ({ name: t, value: t }));

  const type = (await select({
    message: `    State category for "${name}":`,
    choices: typeChoices,
  })) as T;

  const color = (await input({
    message: '    Hex color (optional, e.g. #95A2B3):',
    default: '#95A2B3',
  })).trim() || undefined;

  return { name, type, color };
}

async function mapStatuses(
  uniqueStatuses: Set<string>,
  builtIns: string[],
  kind: 'issue' | 'project',
): Promise<{
  mappings: Record<string, string>;
  customIssue: CustomIssueStateDef[];
  customProject: CustomProjectStatusDef[];
}> {
  const mappings: Record<string, string> = {};
  const customIssue: CustomIssueStateDef[] = [];
  const customProject: CustomProjectStatusDef[] = [];
  const alreadyDefined = new Set<string>();

  for (const status of uniqueStatuses) {
    const choices = [
      ...builtIns.map((s) => ({ name: s, value: s })),
      ...[...alreadyDefined]
        .filter((n) => !builtIns.includes(n))
        .map((n) => ({ name: `${n} (custom)`, value: n })),
      { name: '+ Add custom Linear status...', value: CUSTOM_STATUS_SENTINEL },
    ];

    const choice = await select({
      message: `  "${status}" →`,
      choices,
    });

    if (choice === CUSTOM_STATUS_SENTINEL) {
      if (kind === 'issue') {
        const def = await promptCustomStatus<IssueStateType>(status, 'issue');
        customIssue.push(def);
        mappings[status] = def.name;
        alreadyDefined.add(def.name);
      } else {
        const def = await promptCustomStatus<ProjectStatusType>(status, 'project');
        customProject.push(def);
        mappings[status] = def.name;
        alreadyDefined.add(def.name);
      }
    } else {
      mappings[status] = choice;
      alreadyDefined.add(choice);
    }
  }

  return { mappings, customIssue, customProject };
}

export interface InitOptions {
  output: string;
}

export async function initCommand(excelPath: string, options: InitOptions): Promise<void> {
  console.log(`\n📊 Analyzing Monday.com export: ${excelPath}\n`);

  // Parse the Monday.com export
  const { board, updates } = parseMondayExport(excelPath);
  const summary = getBoardSummary(board);

  // Display board summary
  console.log('Board Analysis:');
  console.log('='.repeat(50));
  console.log(`  Board name: ${board.name}`);
  console.log(`  Groups: ${summary.totalGroups}`);
  console.log(`  Main items: ${summary.totalMainItems}`);
  console.log(`  Total subitems: ${summary.totalSubitems}`);
  if (updates) {
    console.log(`  Updates sheet: ${updates.updates.length} updates`);
  }
  
  // Display columns
  console.log('\nMain Item Columns:');
  console.log('-'.repeat(50));
  for (const col of summary.mainItemColumns) {
    console.log(`  ${col.letter.padEnd(3)} ${col.name}`);
  }
  
  if (summary.subitemColumns.length > 0) {
    console.log('\nSubitem Columns:');
    console.log('-'.repeat(50));
    for (const col of summary.subitemColumns) {
      console.log(`  ${col.letter.padEnd(3)} ${col.name}`);
    }
  }

  console.log('\n' + '='.repeat(50));
  console.log('Starting Configuration Wizard');
  console.log('='.repeat(50) + '\n');

  // Build column choices with letter prefixes
  const mainColChoices = summary.mainItemColumns.map(col => ({
    name: `${col.letter} - ${col.name}`,
    value: col.name,
  }));

  // Data model
  const importAs = await select({
    message: 'How should main items be imported to Linear?',
    choices: [
      { name: 'As Projects (recommended for portfolios/initiatives)', value: 'project' as const },
      { name: 'As Issues (for task lists)', value: 'issue' as const },
    ],
  });

  // Name column
  const nameColGuess = summary.mainItemColumns.find(c => c.name.toLowerCase() === 'name');
  const nameColumn = await select({
    message: 'Which column contains the item name/title?',
    choices: mainColChoices,
    default: nameColGuess?.name,
  });

  // Description columns
  const descriptionColumns = await checkbox({
    message: `Which column(s) should be combined into the description?\n  (Use SPACE to select, ENTER to confirm. Select multiple for combined description)`,
    choices: mainColChoices.map(c => ({ ...c, checked: false })),
  });

  // Status column
  const statusColGuess = summary.mainItemColumns.find(c => 
    c.name.toLowerCase().includes('status') || c.name.toLowerCase().includes('lifecycle')
  );
  
  const hasStatus = await confirm({
    message: 'Do you want to map a status column?',
    default: !!statusColGuess,
  });

  let statusColumn: string | undefined;
  let statusMappings: Record<string, string> = { '_default': 'Backlog' };
  let customIssueStates: CustomIssueStateDef[] = [];
  let customProjectStatuses: CustomProjectStatusDef[] = [];

  if (hasStatus) {
    statusColumn = await select({
      message: 'Which column contains the status?',
      choices: mainColChoices,
      default: statusColGuess?.name,
    });

    // Collect unique status values and prompt for mapping
    const uniqueStatuses = new Set<string>();
    for (const item of board.items.filter(i => i.type === 'mainItem')) {
      const status = item.data[statusColumn];
      if (status) uniqueStatuses.add(status);
    }

    if (uniqueStatuses.size > 0 && uniqueStatuses.size <= 15) {
      const kind: 'issue' | 'project' = importAs === 'project' ? 'project' : 'issue';
      console.log(`\nMap each status to a Linear ${kind} status (or add a custom one):`);
      const linearProjectStatuses = ['Backlog', 'Planned', 'Started', 'Paused', 'Completed', 'Canceled'];
      const linearIssueStatuses = ['Backlog', 'Todo', 'In Progress', 'In Review', 'Done', 'Canceled'];
      const builtIns = kind === 'project' ? linearProjectStatuses : linearIssueStatuses;

      const result = await mapStatuses(uniqueStatuses, builtIns, kind);
      statusMappings = { ...statusMappings, ...result.mappings };
      customIssueStates = result.customIssue;
      customProjectStatuses = result.customProject;
    }
  }

  // Lead/Owner column
  const leadColGuess = summary.mainItemColumns.find(c => 
    c.name.toLowerCase().includes('owner') || 
    c.name.toLowerCase().includes('manager') ||
    c.name.toLowerCase().includes('lead')
  );

  let leadColumn: string | undefined;
  if (leadColGuess || summary.mainItemColumns.some(c => c.name.toLowerCase().includes('owner'))) {
    const hasLead = await confirm({
      message: 'Do you want to map an owner/lead column?',
      default: !!leadColGuess,
    });
    
    if (hasLead) {
      leadColumn = await select({
        message: 'Which column contains the owner/lead?',
        choices: [
          { name: '(none)', value: '' },
          ...mainColChoices,
        ],
        default: leadColGuess?.name,
      }) || undefined;
    }
  }

  // Date columns
  const timelineColGuess = summary.mainItemColumns.find(c => 
    c.name.toLowerCase().includes('timeline') || c.name.toLowerCase().includes('gantt')
  );
  const startDateGuess = summary.mainItemColumns.find(c => 
    c.name.toLowerCase().includes('start')
  );
  const endDateGuess = summary.mainItemColumns.find(c => 
    c.name.toLowerCase().includes('end') || c.name.toLowerCase().includes('target') || c.name.toLowerCase().includes('due')
  );

  let timelineColumn: string | undefined;
  let startDateColumn: string | undefined;
  let targetDateColumn: string | undefined;

  if (timelineColGuess) {
    const useTimeline = await confirm({
      message: `Found timeline column "${timelineColGuess.name}". Use for start/end dates?`,
      default: true,
    });
    
    if (useTimeline) {
      timelineColumn = timelineColGuess.name;
    }
  }

  if (!timelineColumn && (startDateGuess || endDateGuess)) {
    const hasDates = await confirm({
      message: 'Do you want to map date columns?',
      default: true,
    });
    
    if (hasDates) {
      startDateColumn = await select({
        message: 'Start date column:',
        choices: [{ name: '(none)', value: '' }, ...mainColChoices],
        default: startDateGuess?.name,
      }) || undefined;
      
      targetDateColumn = await select({
        message: 'End/target date column:',
        choices: [{ name: '(none)', value: '' }, ...mainColChoices],
        default: endDateGuess?.name,
      }) || undefined;
    }
  }

  // Group labels
  const useGroups = await confirm({
    message: `Import board groups (${board.groups.length} found) as Linear labels?`,
    default: board.groups.length > 0,
  });

  // Label columns
  const labelCandidates = summary.mainItemColumns.filter(c => {
    const uniqueValues = new Set<string>();
    for (const item of board.items.filter(i => i.type === 'mainItem')) {
      const val = item.data[c.name];
      if (val) uniqueValues.add(val);
    }
    return uniqueValues.size > 1 && uniqueValues.size < 20;
  });

  let labelColumns: string[] = [];
  let labelGroups: Record<string, string> = {};

  if (labelCandidates.length > 0) {
    console.log('\n📌 Label Configuration');
    console.log('   Columns with limited unique values can become Linear labels.\n');
    
    const selectedLabelCols = await checkbox({
      message: `Select columns to import as labels:\n  (Use SPACE to select, ENTER to confirm)`,
      choices: labelCandidates.map(c => {
        const uniqueCount = new Set(
          board.items.filter(i => i.type === 'mainItem')
            .map(i => i.data[c.name])
            .filter(v => v)
        ).size;
        return {
          name: `${c.letter} - ${c.name} (${uniqueCount} values)`,
          value: c.name,
        };
      }),
    });
    
    labelColumns = selectedLabelCols;

    // Configure each label column
    for (const col of labelColumns) {
      const groupName = await input({
        message: `Label group name for "${col}":`,
        default: col.replace(/^\*\s*/, ''), // Remove leading asterisk if present
      });
      labelGroups[col] = groupName;
    }
  }

  // Subitems
  let importSubitems = false;
  let subitemFieldMappings: Record<string, FieldMapping> = {};
  let issueStatusMappings: Record<string, string> = { '_default': 'Backlog' };
  
  if (summary.totalSubitems > 0) {
    importSubitems = await confirm({
      message: `Import subitems (${summary.totalSubitems} found) as Linear issues?`,
      default: true,
    });
    
    if (importSubitems && summary.subitemColumns.length > 0) {
      console.log('\n📋 Subitem Field Mapping');
      console.log('   Configure how subitem columns map to Linear issue fields.\n');
      
      const subitemColChoices = summary.subitemColumns.map(col => ({
        name: `${col.letter} - ${col.name}`,
        value: col.name,
      }));
      
      // Subitem name column (usually "Name")
      const subitemNameGuess = summary.subitemColumns.find(c => c.name.toLowerCase() === 'name');
      const subitemNameCol = await select({
        message: 'Subitem title column:',
        choices: subitemColChoices,
        default: subitemNameGuess?.name,
      });
      subitemFieldMappings.title = { source: subitemNameCol };
      
      // Subitem status column
      const subitemStatusGuess = summary.subitemColumns.find(c => 
        c.name.toLowerCase().includes('status')
      );
      
      if (subitemStatusGuess) {
        const mapSubitemStatus = await confirm({
          message: `Map subitem status column "${subitemStatusGuess.name}"?`,
          default: true,
        });
        
        if (mapSubitemStatus) {
          const subitemStatusCol = await select({
            message: 'Subitem status column:',
            choices: subitemColChoices,
            default: subitemStatusGuess.name,
          });
          subitemFieldMappings.state = { source: subitemStatusCol, transform: 'issueStatusMap' as TransformType };
          
          // Collect unique subitem status values
          const uniqueSubitemStatuses = new Set<string>();
          for (const item of board.items.filter(i => i.type === 'subitem')) {
            const status = item.data[subitemStatusCol];
            if (status) uniqueSubitemStatuses.add(status);
          }
          
          if (uniqueSubitemStatuses.size > 0 && uniqueSubitemStatuses.size <= 15) {
            console.log('\nMap each subitem status to a Linear issue state (or add a custom one):');
            const linearIssueStates = ['Backlog', 'Todo', 'In Progress', 'In Review', 'Done', 'Canceled'];

            const result = await mapStatuses(uniqueSubitemStatuses, linearIssueStates, 'issue');
            issueStatusMappings = { ...issueStatusMappings, ...result.mappings };
            customIssueStates = [...customIssueStates, ...result.customIssue];
          }
        }
      }
      
      // Subitem description column
      const subitemDescGuess = summary.subitemColumns.find(c => 
        c.name.toLowerCase().includes('description') || 
        c.name.toLowerCase().includes('information') ||
        c.name.toLowerCase().includes('notes')
      );
      
      if (subitemDescGuess) {
        const mapSubitemDesc = await confirm({
          message: `Map subitem description column "${subitemDescGuess.name}"?`,
          default: true,
        });
        
        if (mapSubitemDesc) {
          const subitemDescCol = await select({
            message: 'Subitem description column:',
            choices: [{ name: '(none)', value: '' }, ...subitemColChoices],
            default: subitemDescGuess.name,
          });
          if (subitemDescCol) {
            subitemFieldMappings.description = { source: subitemDescCol };
          }
        }
      }
      
      // Subitem assignee column
      const subitemAssigneeGuess = summary.subitemColumns.find(c => 
        c.name.toLowerCase().includes('assignee') || 
        c.name.toLowerCase().includes('owner') ||
        c.name.toLowerCase().includes('lead')
      );
      
      if (subitemAssigneeGuess) {
        const mapSubitemAssignee = await confirm({
          message: `Map subitem assignee column "${subitemAssigneeGuess.name}"?`,
          default: true,
        });
        
        if (mapSubitemAssignee) {
          const subitemAssigneeCol = await select({
            message: 'Subitem assignee column:',
            choices: [{ name: '(none)', value: '' }, ...subitemColChoices],
            default: subitemAssigneeGuess.name,
          });
          if (subitemAssigneeCol) {
            subitemFieldMappings.assignee = { source: subitemAssigneeCol, transform: 'user' as TransformType };
          }
        }
      }
      
      // Subitem due date column
      const subitemDueDateGuess = summary.subitemColumns.find(c => 
        c.name.toLowerCase().includes('date') || 
        c.name.toLowerCase().includes('due') ||
        c.name.toLowerCase().includes('deadline')
      );
      
      if (subitemDueDateGuess) {
        const mapSubitemDueDate = await confirm({
          message: `Map subitem date column "${subitemDueDateGuess.name}"?`,
          default: true,
        });
        
        if (mapSubitemDueDate) {
          const subitemDueDateCol = await select({
            message: 'Subitem due date column:',
            choices: [{ name: '(none)', value: '' }, ...subitemColChoices],
            default: subitemDueDateGuess.name,
          });
          if (subitemDueDateCol) {
            subitemFieldMappings.dueDate = { source: subitemDueDateCol, transform: 'date' as TransformType };
          }
        }
      }
    }
  }

  // Deduplication
  const deduplicationEnabled = await confirm({
    message: 'Enable deduplication (skip existing items on re-run)?',
    default: true,
  });

  // Updates
  let importUpdates = false;
  let updatesConfig: { contentColumn?: string; linkColumn?: string } = {};
  
  if (updates && updates.updates.length > 0) {
    importUpdates = await confirm({
      message: `Import updates (${updates.updates.length} found) as comments?`,
      default: true,
    });
    
    if (importUpdates) {
      const updateColChoices = updates.headers.map((h, idx) => ({
        name: `${columnIndexToLetter(idx)} - ${h}`,
        value: h,
      }));
      
      updatesConfig.contentColumn = await select({
        message: 'Which column contains the update content?',
        choices: updateColChoices,
      });
      
      updatesConfig.linkColumn = await select({
        message: 'Which column links updates to items?',
        choices: updateColChoices,
      });
    }
  }

  // Generate config
  console.log('\n' + '='.repeat(50));
  console.log('Generating Configuration...');
  console.log('='.repeat(50));

  // Build field mappings based on import type
  const fieldMappings: ImportConfig['fieldMappings'] = {};
  
  if (importAs === 'project') {
    fieldMappings.project = buildProjectMappings(nameColumn, descriptionColumns, statusColumn, leadColumn, timelineColumn, startDateColumn, targetDateColumn);
    // When importing main items as projects, subitems become issues — their
    // mappings go on fieldMappings.issue.
    if (importSubitems && Object.keys(subitemFieldMappings).length > 0) {
      fieldMappings.issue = subitemFieldMappings;
    }
  } else {
    fieldMappings.issue = buildIssueMappings(nameColumn, descriptionColumns, statusColumn, leadColumn);
    // In parent-issue mode, subitems use their own header set (e.g. "Status
    // of Work" instead of "Status") — keep them on fieldMappings.subitem so
    // the parent mapping isn't overwritten.
    if (importSubitems && Object.keys(subitemFieldMappings).length > 0) {
      fieldMappings.subitem = subitemFieldMappings;
    }
  }

  const config: ImportConfig = {
    version: '1.0',
    source: {
      sheets: {
        items: board.name,
        updates: updates ? 'updates' : undefined,
      },
      headerRow: 3, // Monday.com exports have headers at row 3 (1-indexed)
    },
    target: {
      team: 'prompt',
      createMissingLabels: true,
    },
    dataModel: {
      items: {
        importAs,
        subitems: importSubitems ? {
          enabled: true,
          importAs: 'issue',
          sourceColumn: 'Subitems',
          delimiter: '\n',
        } : undefined,
      },
    },
    fieldMappings,
    statusMapping: statusMappings,
    issueStatusMapping: importSubitems ? issueStatusMappings : undefined,
    customIssueStates: customIssueStates.length > 0 ? dedupeByName(customIssueStates) : undefined,
    customProjectStatuses: customProjectStatuses.length > 0 ? dedupeByName(customProjectStatuses) : undefined,
    priorityMapping: { '_default': 0 },
    labels: labelColumns.map(col => ({
      sourceColumn: col,
      groupName: labelGroups[col] || col,
      createGroup: true,
    })),
    groups: useGroups ? {
      enabled: true,
      sourceColumn: '_group', // Special handling for Monday.com groups
      groupName: 'Board Section',
    } : undefined,
    updates: importUpdates ? {
      enabled: true,
      contentColumn: updatesConfig.contentColumn,
      linkColumn: updatesConfig.linkColumn,
      sortOrder: 'asc',
      authorFallback: 'prepend',
    } : undefined,
    options: {
      continueOnError: true,
      rateLimitMs: 100,
      skipEmpty: true,
    },
    deduplication: deduplicationEnabled ? {
      enabled: true,
      matchBy: 'name',
      onDuplicate: 'skip',
    } : undefined,
  };

  // Write config file
  const outputPath = resolve(options.output);
  writeFileSync(outputPath, JSON.stringify(config, null, 2));
  
  console.log(`\n✅ Config saved to: ${outputPath}`);
  
  console.log('\n📋 Configuration Summary:');
  console.log(`   Import as: ${importAs}s`);
  console.log(`   Name column: ${nameColumn}`);
  if (descriptionColumns.length > 0) {
    console.log(`   Description: ${descriptionColumns.join(' + ')}`);
  }
  if (statusColumn) {
    console.log(`   Status column: ${statusColumn}`);
  }
  if (leadColumn) {
    console.log(`   Lead column: ${leadColumn}`);
  }
  if (useGroups) {
    console.log(`   Groups → Labels: ${board.groups.length} groups`);
  }
  if (labelColumns.length > 0) {
    console.log(`   Label columns: ${labelColumns.join(', ')}`);
  }
  if (importSubitems) {
    console.log(`   Subitems: ${summary.totalSubitems} → Issues`);
    if (Object.keys(subitemFieldMappings).length > 0) {
      const mappedFields = Object.keys(subitemFieldMappings).join(', ');
      console.log(`   Subitem fields: ${mappedFields}`);
    }
    if (Object.keys(issueStatusMappings).length > 1) {
      console.log(`   Subitem statuses: ${Object.keys(issueStatusMappings).filter(k => k !== '_default').length} mapped`);
    }
  }
  if (importUpdates) {
    console.log(`   Updates: ${updates?.updates.length} → Project Updates`);
  }

  console.log('\n🚀 Next steps:');
  console.log('   1. Review and customize the config file if needed');
  console.log('   2. Set your Linear API key:');
  console.log('      export LINEAR_API_KEY=lin_api_...');
  console.log('   3. Run a dry run to preview:');
  console.log(`      npx tsx src/index.ts dry-run -c ${options.output} -f "${excelPath}"`);
  console.log('   4. Execute the import:');
  console.log(`      npx tsx src/index.ts run -c ${options.output} -f "${excelPath}"`);
}

/**
 * Build project field mappings, excluding undefined values
 */
function buildProjectMappings(
  nameColumn: string,
  descriptionColumns: string[],
  statusColumn: string | undefined,
  leadColumn: string | undefined,
  timelineColumn: string | undefined,
  startDateColumn: string | undefined,
  targetDateColumn: string | undefined,
): Record<string, FieldMapping> {
  const mappings: Record<string, FieldMapping> = {
    name: { source: nameColumn },
  };

  if (descriptionColumns.length === 1) {
    mappings.description = { source: descriptionColumns[0] };
  } else if (descriptionColumns.length > 1) {
    mappings.description = {
      sources: descriptionColumns,
      template: descriptionColumns.map(col => 
        `## ${col.replace(/^\*\s*/, '')}\n{{${col}}}`
      ).join('\n\n') + '\n\n---\n_Imported from Monday.com_',
    };
  }

  if (statusColumn) {
    mappings.state = { source: statusColumn, transform: 'statusMap' as TransformType };
  }

  if (leadColumn) {
    mappings.lead = { source: leadColumn, transform: 'user' as TransformType };
  }

  if (timelineColumn) {
    mappings.startDate = { source: timelineColumn, transform: 'timelineStart' as TransformType };
    mappings.targetDate = { source: timelineColumn, transform: 'timelineEnd' as TransformType };
  } else {
    if (startDateColumn) {
      mappings.startDate = { source: startDateColumn, transform: 'date' as TransformType };
    }
    if (targetDateColumn) {
      mappings.targetDate = { source: targetDateColumn, transform: 'date' as TransformType };
    }
  }

  return mappings;
}

/**
 * Build issue field mappings, excluding undefined values
 */
function buildIssueMappings(
  nameColumn: string,
  descriptionColumns: string[],
  statusColumn: string | undefined,
  leadColumn: string | undefined,
): Record<string, FieldMapping> {
  const mappings: Record<string, FieldMapping> = {
    title: { source: nameColumn },
  };

  if (descriptionColumns.length > 0) {
    mappings.description = { source: descriptionColumns[0] };
  }

  if (statusColumn) {
    mappings.state = { source: statusColumn, transform: 'statusMap' as TransformType };
  }

  if (leadColumn) {
    mappings.assignee = { source: leadColumn, transform: 'user' as TransformType };
  }

  return mappings;
}
