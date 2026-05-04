import { LinearIssue, JiraIssue, MatchResult, Config, Logger } from '../types';
import { JiraApiClient } from '../clients/jira';

const JIRA_KEY_PATTERNS = [
  /\/browse\/([A-Z]+-\d+)/i,
  /\/([A-Z]+-\d+)$/i,
];

export class IssueMatcher {
  constructor(
    private config: Config,
    private jiraClient: JiraApiClient,
    private logger: Logger
  ) {}

  // Returns ordered candidate Jira keys for a Linear issue without making API calls.
  // Used by the batch sync path to collect all keys before a single JQL fetch.
  resolveCandidateKeys(linearIssue: LinearIssue): string[] {
    const keys: string[] = [];
    switch (this.config.matching.strategy) {
      case 'identifier':
        keys.push(linearIssue.identifier);
        break;
      case 'attachment-url':
        for (const url of linearIssue.attachments || []) {
          const key = this.extractKeyFromUrl(url);
          if (key && !keys.includes(key)) keys.push(key);
        }
        break;
      case 'hybrid':
        keys.push(linearIssue.identifier);
        for (const url of linearIssue.attachments || []) {
          const key = this.extractKeyFromUrl(url);
          if (key && !keys.includes(key)) keys.push(key);
        }
        break;
    }
    return keys;
  }

  // Find the best matching Jira issue from a pre-fetched map (batch path).
  findMatchInBatch(linearIssue: LinearIssue, jiraMap: Map<string, JiraIssue>): JiraIssue | null {
    for (const key of this.resolveCandidateKeys(linearIssue)) {
      const issue = jiraMap.get(key);
      if (issue) return issue;
    }
    return null;
  }

  private extractKeyFromUrl(url: string): string | null {
    for (const pattern of JIRA_KEY_PATTERNS) {
      const match = url.match(pattern);
      if (match?.[1]) return match[1].toUpperCase();
    }
    return null;
  }

  async findBestMatch(linearIssue: LinearIssue): Promise<MatchResult> {
    this.logger.debug(
      `Finding match for Linear issue: "${linearIssue.title}" (${linearIssue.identifier}) using strategy: ${this.config.matching.strategy}`
    );

    try {
      switch (this.config.matching.strategy) {
        case 'identifier':
          return await this.matchByIdentifier(linearIssue);

        case 'attachment-url':
          return await this.matchByAttachmentUrl(linearIssue);

        case 'hybrid': {
          const identifierResult = await this.matchByIdentifier(linearIssue);
          if (identifierResult.jiraIssue) return identifierResult;
          this.logger.debug(`Identifier match failed for "${linearIssue.title}", trying attachment URLs`);
          return await this.matchByAttachmentUrl(linearIssue);
        }

        default:
          return {
            linearIssue,
            jiraIssue: null,
            reason: `Unknown matching strategy: ${this.config.matching.strategy}`,
          };
      }
    } catch (error) {
      this.logger.error(`Error matching issue "${linearIssue.title}": ${error}`);
      return {
        linearIssue,
        jiraIssue: null,
        reason: `Lookup error: ${error}`,
      };
    }
  }

  private async matchByIdentifier(linearIssue: LinearIssue): Promise<MatchResult> {
    this.logger.debug(`Trying identifier match for: ${linearIssue.identifier}`);
    const jiraIssue = await this.jiraClient.getIssueByKey(linearIssue.identifier);
    if (jiraIssue) {
      return {
        linearIssue,
        jiraIssue,
        reason: `Direct match by identifier: ${linearIssue.identifier}`,
      };
    }
    return {
      linearIssue,
      jiraIssue: null,
      reason: `No Jira issue found with key "${linearIssue.identifier}"`,
    };
  }

  private async matchByAttachmentUrl(linearIssue: LinearIssue): Promise<MatchResult> {
    if (!linearIssue.attachments || linearIssue.attachments.length === 0) {
      return {
        linearIssue,
        jiraIssue: null,
        reason: 'No attachments found to search for Jira URLs',
      };
    }

    this.logger.debug(`Searching ${linearIssue.attachments.length} attachment(s) for Jira URLs`);

    for (const jiraUrl of linearIssue.attachments) {
      this.logger.debug(`Trying to fetch Jira issue from URL: ${jiraUrl}`);
      const jiraIssue = await this.jiraClient.getIssueByUrl(jiraUrl);
      if (jiraIssue) {
        return {
          linearIssue,
          jiraIssue,
          reason: `Match found via attachment URL: ${jiraUrl}`,
        };
      }
    }

    return {
      linearIssue,
      jiraIssue: null,
      reason: `No valid Jira issues found in ${linearIssue.attachments.length} attachment URL(s)`,
    };
  }
}
