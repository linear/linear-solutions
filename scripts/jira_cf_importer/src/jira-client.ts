import fetch from 'node-fetch';
import { JiraIssue, JiraConfig, CustomFieldValue } from './types.js';

export class JiraClient {
  private baseUrl: string;
  private email: string;
  private apiToken: string;
  private authHeader: string;
  private apiCallCount: number = 0;

  constructor(baseUrl: string, email: string, apiToken: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.email = email;
    this.apiToken = apiToken;
    this.authHeader = 'Basic ' + Buffer.from(`${email}:${apiToken}`).toString('base64');
  }

  /**
   * Get the total number of API calls made in this session
   */
  getApiCallCount(): number {
    return this.apiCallCount;
  }

  /**
   * Fetch a single Jira issue by key
   */
  async fetchIssue(issueKey: string): Promise<JiraIssue | null> {
    const url = `${this.baseUrl}/rest/api/3/issue/${issueKey}`;
    
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': this.authHeader,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        if (response.status === 404) {
          console.warn(`Jira issue ${issueKey} not found (404)`);
          return null;
        }
        throw new Error(`Jira API error for ${issueKey}: ${response.status} ${response.statusText}`);
      }

      const issue: JiraIssue = await response.json() as JiraIssue;
      return issue;
    } catch (error) {
      console.error(`Error fetching Jira issue ${issueKey}:`, error);
      return null;
    }
  }

  /**
   * Fetch multiple Jira issues by keys
   * Uses batch fetching to minimize API calls
   */
  async fetchIssues(issueKeys: string[]): Promise<Map<string, JiraIssue>> {
    console.log(`Fetching ${issueKeys.length} Jira issues...`);
    
    const issueMap = new Map<string, JiraIssue>();
    
    // Jira's search endpoint can handle multiple keys at once
    // We'll batch them to avoid URL length limits
    const batchSize = 50;
    
    for (let i = 0; i < issueKeys.length; i += batchSize) {
      const batch = issueKeys.slice(i, i + batchSize);
      const jql = `key in (${batch.join(',')})`;
      
      // Use the new /search/jql endpoint as per Jira Cloud API v3
      // Reference: https://developer.atlassian.com/changelog/#CHANGE-2046
      // Note: Must explicitly request fields - the new endpoint only returns 'id' by default
      const url = `${this.baseUrl}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=${batchSize}&fields=*all`;
      
      try {
        this.apiCallCount++;
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'Authorization': this.authHeader,
            'Accept': 'application/json',
          },
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error(`Jira API error for batch: ${response.status} ${response.statusText}`);
          console.error(`Error details: ${errorText}`);
          continue;
        }

        const data: any = await response.json();
        
        if (data.issues && Array.isArray(data.issues)) {
          for (const issue of data.issues) {
            if (issue.key) {
              issueMap.set(issue.key, issue);
            } else {
              console.warn(`Warning: Issue without key property found`);
            }
          }
        } else {
          console.error(`Unexpected API response format. Expected 'issues' array.`);
        }
        
        console.log(`Fetched ${issueMap.size} of ${issueKeys.length} issues...`);
      } catch (error) {
        console.error(`Error fetching batch of Jira issues:`, error);
      }
    }

    return issueMap;
  }

  /**
   * Convert Atlassian Document Format (ADF) to plain text
   */
  private extractTextFromADF(adf: any): string {
    if (!adf || typeof adf !== 'object') {
      return '';
    }

    let text = '';

    // Recursively extract text from ADF nodes
    const extractText = (node: any): void => {
      if (!node) return;

      // If this node has text content, add it
      if (node.text) {
        text += node.text;
      }

      // If this node has content array, recurse through it
      if (Array.isArray(node.content)) {
        for (const child of node.content) {
          extractText(child);
          // Add newlines between paragraphs
          if (child.type === 'paragraph' && text && !text.endsWith('\n')) {
            text += '\n';
          }
        }
      }
    };

    extractText(adf);
    return text.trim();
  }

  /**
   * Extract custom field values from a Jira issue
   */
  extractCustomFields(issue: JiraIssue, customFieldConfigs: any[]): CustomFieldValue[] {
    const values: CustomFieldValue[] = [];

    for (const config of customFieldConfigs) {
      const fieldValue = issue.fields[config.fieldId];
      let value: string | null = null;

      if (fieldValue !== undefined && fieldValue !== null) {
        if (config.fieldType === 'single-select') {
          // Single select fields typically have a 'value' property
          value = fieldValue.value || fieldValue.name || String(fieldValue);
        } else if (config.fieldType === 'text' || config.fieldType === 'multi-line-text') {
          // Text fields can be strings or objects with content property
          if (typeof fieldValue === 'string') {
            value = fieldValue;
          } else if (typeof fieldValue === 'object') {
            // Rich text fields are in ADF (Atlassian Document Format)
            if (fieldValue.type === 'doc' && fieldValue.content) {
              // This is ADF format - extract plain text
              value = this.extractTextFromADF(fieldValue);
            } else {
              // Try other common properties
              value = fieldValue.plainText || fieldValue.text || fieldValue.content || JSON.stringify(fieldValue);
            }
          } else {
            value = String(fieldValue);
          }
        }
      }

      values.push({
        fieldId: config.fieldId,
        fieldName: config.fieldName,
        fieldType: config.fieldType,
        value,
      });
    }

    return values;
  }

  /**
   * Get the web URL for a Jira issue
   */
  getIssueUrl(issueKey: string): string {
    return `${this.baseUrl}/browse/${issueKey}`;
  }
}

