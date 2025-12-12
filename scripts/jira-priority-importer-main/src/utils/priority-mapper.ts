import { PriorityMapping, Config, Logger } from '../types';

export class PriorityMapper {
  private mappings: Map<string, number>;

  constructor(private config: Config, private logger: Logger) {
    this.mappings = new Map();
    this.buildMappings();
  }

  private buildMappings(): void {
    this.logger.debug('Building priority mappings...');
    
    for (const mapping of this.config.priorityMapping) {
      // Normalize Jira priority name for matching
      const normalizedJiraPriority = mapping.jiraPriority.toLowerCase().trim();
      this.mappings.set(normalizedJiraPriority, mapping.linearPriority);
      
      this.logger.debug(`Mapped Jira "${mapping.jiraPriority}" -> Linear ${mapping.linearPriority}`);
    }

    this.logger.info(`Built ${this.mappings.size} priority mappings`);
  }

  mapJiraToLinearPriority(jiraPriorityName: string): number | null {
    const normalizedName = jiraPriorityName.toLowerCase().trim();
    const linearPriority = this.mappings.get(normalizedName);
    
    if (linearPriority !== undefined) {
      this.logger.debug(`Mapped Jira priority "${jiraPriorityName}" to Linear priority ${linearPriority}`);
      return linearPriority;
    }

    // Try partial matches as fallback
    for (const [jiraName, linearPriority] of this.mappings.entries()) {
      if (normalizedName.includes(jiraName) || jiraName.includes(normalizedName)) {
        this.logger.debug(`Partial match: Jira priority "${jiraPriorityName}" to Linear priority ${linearPriority}`);
        return linearPriority;
      }
    }

    this.logger.warn(`No mapping found for Jira priority: "${jiraPriorityName}"`);
    return null;
  }

  getLinearPriorityLabel(priority: number): string {
    switch (priority) {
      case 0: return 'No priority';
      case 1: return 'Urgent';
      case 2: return 'High';
      case 3: return 'Medium';
      case 4: return 'Low';
      default: return 'Unknown';
    }
  }

  validateMappings(): Array<{ jiraPriority: string; issue: string }> {
    const issues: Array<{ jiraPriority: string; issue: string }> = [];

    for (const mapping of this.config.priorityMapping) {
      // Validate Linear priority range
      if (mapping.linearPriority < 0 || mapping.linearPriority > 4) {
        issues.push({
          jiraPriority: mapping.jiraPriority,
          issue: `Linear priority must be between 0-4, got: ${mapping.linearPriority}`,
        });
      }

      // Check for empty Jira priority
      if (!mapping.jiraPriority || mapping.jiraPriority.trim() === '') {
        issues.push({
          jiraPriority: mapping.jiraPriority,
          issue: 'Jira priority name cannot be empty',
        });
      }
    }

    // Check for duplicate Jira priorities
    const jiraPriorities = this.config.priorityMapping.map(m => m.jiraPriority.toLowerCase().trim());
    const duplicates = jiraPriorities.filter((priority, index) => jiraPriorities.indexOf(priority) !== index);
    
    for (const duplicate of new Set(duplicates)) {
      issues.push({
        jiraPriority: duplicate,
        issue: 'Duplicate Jira priority mapping found',
      });
    }

    return issues;
  }

  getMappingSummary(): string {
    const lines = ['Priority Mappings:'];
    
    for (const mapping of this.config.priorityMapping) {
      const linearLabel = this.getLinearPriorityLabel(mapping.linearPriority);
      lines.push(`  ${mapping.jiraPriority} -> ${mapping.linearPriority} (${linearLabel})`);
    }

    return lines.join('\n');
  }
}
