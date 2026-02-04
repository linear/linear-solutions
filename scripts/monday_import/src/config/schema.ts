/**
 * Configuration schema types for Monday.com to Linear import
 */

export interface ImportConfig {
  $schema?: string;
  version: string;
  source: SourceConfig;
  target: TargetConfig;
  dataModel: DataModelConfig;
  fieldMappings: FieldMappingsConfig;
  statusMapping: Record<string, string>;
  issueStatusMapping?: Record<string, string>;
  priorityMapping: Record<string, number>;
  labels: LabelConfig[];
  groups?: GroupsConfig;
  checkboxes?: CheckboxConfig[];
  links?: LinksConfig;
  dependencies?: DependenciesConfig;
  updates?: UpdatesConfig;
  userMapping?: UserMappingConfig;
  options: OptionsConfig;
  deduplication?: DeduplicationConfig;
}

export interface SourceConfig {
  sheets: {
    items: string;
    updates?: string;
  };
  headerRow: number;
  identifierColumn?: string;
  groupColumn?: string;
}

export interface TargetConfig {
  team: string | 'prompt';
  createMissingLabels: boolean;
}

export interface DataModelConfig {
  items: {
    importAs: ImportAs;
    subitems?: SubitemsConfig;
  };
}

export interface SubitemsConfig {
  enabled: boolean;
  importAs: 'issue' | 'subIssue';
  sourceColumn: string;
  delimiter: string;
}

export type ImportAs = 'project' | 'issue' | 'parentIssue';

export interface FieldMappingsConfig {
  project?: Record<string, FieldMapping>;
  issue?: Record<string, FieldMapping>;
}

export interface FieldMapping {
  source?: string;
  sources?: string[];
  transform?: TransformType;
  template?: string;
  default?: string | number | null;
}

export type TransformType = 
  | 'statusMap' 
  | 'issueStatusMap'
  | 'priorityMap' 
  | 'date' 
  | 'user' 
  | 'number' 
  | 'timelineStart' 
  | 'timelineEnd';

export interface LabelConfig {
  sourceColumn: string;
  groupName?: string;
  createGroup?: boolean;
  delimiter?: string;
  color?: string;
  flat?: boolean;
  valueMapping?: Record<string, string>;
}

export interface GroupsConfig {
  enabled: boolean;
  sourceColumn: string;
  groupName?: string;
}

export interface CheckboxConfig {
  sourceColumn: string;
  labelWhenChecked: string;
  color?: string;
}

export interface LinksConfig {
  enabled: boolean;
  columns: LinkColumnConfig[];
}

export interface LinkColumnConfig {
  source: string;
  title?: string;
}

export interface DependenciesConfig {
  enabled: boolean;
  blocksColumn?: string;
  blockedByColumn?: string;
  matchBy: 'name' | 'mondayId';
}

export interface UpdatesConfig {
  enabled: boolean;
  dateColumn?: string;
  authorColumn?: string;
  contentColumn?: string;
  linkColumn?: string;
  sortOrder: 'asc' | 'desc';
  authorFallback: AuthorFallback;
}

export type AuthorFallback = 'prepend' | 'append' | 'skip';

export interface UserMappingConfig {
  file?: string;
  fallbackBehavior: 'appendToContent' | 'skip' | 'defaultUser';
  fallbackTemplate?: string;
  defaultUserId?: string;
}

export interface OptionsConfig {
  dryRun?: boolean;
  continueOnError?: boolean;
  rateLimitMs?: number;
  skipEmpty?: boolean;
}

export interface DeduplicationConfig {
  enabled: boolean;
  matchBy: string;
  onDuplicate: 'skip' | 'update' | 'create';
}

// Default configuration values
export const DEFAULT_CONFIG: Partial<ImportConfig> = {
  version: '1.0',
  source: {
    sheets: {
      items: 'Sheet1',
    },
    headerRow: 1,
  },
  target: {
    team: 'prompt',
    createMissingLabels: true,
  },
  dataModel: {
    items: {
      importAs: 'project',
    },
  },
  statusMapping: {
    '_default': 'Backlog',
  },
  priorityMapping: {
    '_default': 0,
  },
  labels: [],
  options: {
    dryRun: false,
    continueOnError: true,
    rateLimitMs: 100,
    skipEmpty: true,
  },
};
