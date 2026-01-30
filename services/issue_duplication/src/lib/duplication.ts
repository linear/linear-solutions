import type { LinearClientWrapper } from "./linear.js";
import type { DuplicationRule, TargetTeam, IssueData } from "../types.js";

export interface DuplicationResult {
  success: boolean;
  skipped: boolean;
  reason?: string;
  ruleName: string;
  createdIssues: Array<{
    id: string;
    identifier: string;
    teamName: string;
  }>;
}

/**
 * Process issue duplication for a specific rule
 *
 * This replicates the behavior of the internal IssueInternalMultiPlatformProcessor:
 * - Creates sub-issues for each target team in the rule
 * - Prefixes titles with team name
 * - Copies description to sub-issues
 * - Links sub-issues as children of parent
 * - Skips if issue already has children
 * - Skips target teams that match the parent issue's team
 */
export async function duplicateIssueForRule(
  client: LinearClientWrapper,
  issue: IssueData,
  rule: DuplicationRule
): Promise<DuplicationResult> {
  const result: DuplicationResult = {
    success: false,
    skipped: false,
    ruleName: rule.name,
    createdIssues: [],
  };

  // Check if issue already has children
  const hasChildren = await client.hasChildren(issue.id);
  if (hasChildren) {
    console.log(
      `[${rule.name}] Issue ${issue.identifier} already has sub-issues, skipping`
    );
    result.skipped = true;
    result.reason = "Issue already has sub-issues";
    result.success = true;
    return result;
  }

  // Get the full issue description (webhook payload may have truncated it)
  const description = await client.getIssueDescription(issue.id);

  // Filter out target teams that match the parent issue's team
  // (in case the source team is also in the target teams list)
  const teamsToCreate = rule.targetTeams.filter(
    (team) => team.teamId !== issue.teamId
  );

  if (teamsToCreate.length === 0) {
    console.log(
      `[${rule.name}] Issue ${issue.identifier} is already in a target team, no sub-issues to create`
    );
    result.skipped = true;
    result.reason = "Parent issue is already in a target team";
    result.success = true;
    return result;
  }

  console.log(
    `[${rule.name}] Creating ${teamsToCreate.length} sub-issues for issue ${issue.identifier}`
  );

  // Create sub-issues for each target team
  for (const team of teamsToCreate) {
    const subIssue = await createSubIssueForTeam(
      client,
      issue,
      team,
      rule.name,
      description
    );

    if (subIssue) {
      result.createdIssues.push({
        id: subIssue.id,
        identifier: subIssue.identifier,
        teamName: team.name,
      });
    }
  }

  result.success = result.createdIssues.length === teamsToCreate.length;

  if (result.createdIssues.length > 0) {
    console.log(
      `[${rule.name}] Created ${result.createdIssues.length} sub-issues: ${result.createdIssues
        .map((i) => i.identifier)
        .join(", ")}`
    );
  }

  return result;
}

/**
 * Create a single sub-issue for a target team
 */
async function createSubIssueForTeam(
  client: LinearClientWrapper,
  parentIssue: IssueData,
  targetTeam: TargetTeam,
  ruleName: string,
  description?: string
): Promise<{ id: string; identifier: string } | null> {
  const title = `${targetTeam.name}: ${parentIssue.title}`;

  console.log(`[${ruleName}] Creating sub-issue "${title}" in team ${targetTeam.name}`);

  const subIssue = await client.createSubIssue({
    title,
    description,
    teamId: targetTeam.teamId,
    parentId: parentIssue.id,
    // Copy priority from parent
    priority: parentIssue.priority,
  });

  if (!subIssue) {
    console.error(
      `[${ruleName}] Failed to create sub-issue for team ${targetTeam.name}`
    );
    return null;
  }

  return {
    id: subIssue.id,
    identifier: subIssue.identifier,
  };
}

/**
 * Check if an issue should trigger duplication
 */
export function shouldProcessIssue(issue: IssueData): boolean {
  // Don't process issues that are already sub-issues
  if (issue.parentId) {
    console.log(`Issue ${issue.identifier} is a sub-issue, skipping`);
    return false;
  }

  return true;
}
