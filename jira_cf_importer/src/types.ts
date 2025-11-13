export interface Config {
  linear: LinearConfig;
  jira: JiraConfig;
}

export interface LinearConfig {
  teamIds?: string[];
  startDate?: string;
  endDate?: string;
  labelScope: 'workspace' | 'team';
  createMissingLabels: boolean;
}

export interface JiraConfig {
  baseUrl: string;
  customFields: CustomFieldConfig[];
}

export interface CustomFieldConfig {
  fieldId: string;
  fieldName: string;
  fieldType: 'single-select' | 'text' | 'multi-line-text';
}

export interface JiraIssue {
  key: string;
  id: string;
  self: string;
  fields: {
    [key: string]: any;
    summary: string;
    created: string;
    updated: string;
  };
}

export interface LinearIssueWithJira {
  linearIssueId: string;
  linearIssueIdentifier: string;
  jiraKeys: string[];
  jiraUrls: string[];
}

export interface CustomFieldValue {
  fieldId: string;
  fieldName: string;
  fieldType: 'single-select' | 'text' | 'multi-line-text';
  value: string | null;
}

