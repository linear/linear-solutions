import { LinearIssue, JiraIssue, MatchResult, Config, Logger } from '../types';
import { JiraApiClient } from '../clients/jira';

export class IssueMatcher {
  constructor(
    private config: Config,
    private jiraClient: JiraApiClient,
    private logger: Logger
  ) {}

  async findBestMatch(linearIssue: LinearIssue): Promise<MatchResult> {
    this.logger.debug(`Finding match for Linear issue: "${linearIssue.title}" (${linearIssue.identifier}) using strategy: ${this.config.matching.strategy}`);

    try {
      switch (this.config.matching.strategy) {
        case 'identifier':
          return await this.matchByIdentifier(linearIssue);
        
        case 'attachment-url':
          return await this.matchByAttachmentUrl(linearIssue);
        
        case 'hybrid':
          // Try identifier first, fall back to attachment URL
          const identifierResult = await this.matchByIdentifier(linearIssue);
          if (identifierResult.jiraIssue) {
            return identifierResult;
          }
          
          this.logger.debug(`Identifier match failed for "${linearIssue.title}", trying attachment URLs`);
          return await this.matchByAttachmentUrl(linearIssue);
        
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
        matchScore: 1.0,
        reason: `Direct match by identifier: ${linearIssue.identifier}`,
      };
    } else {
      return {
        linearIssue,
        jiraIssue: null,
        reason: `No Jira issue found with key "${linearIssue.identifier}"`,
      };
    }
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

    // Try each Jira URL found in attachments
    for (const jiraUrl of linearIssue.attachments) {
      this.logger.debug(`Trying to fetch Jira issue from URL: ${jiraUrl}`);
      
      const jiraIssue = await this.jiraClient.getIssueByUrl(jiraUrl);
      
      if (jiraIssue) {
        return {
          linearIssue,
          jiraIssue,
          matchScore: 1.0,
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
