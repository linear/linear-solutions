import { LinearClient, Issue, WorkflowState } from "@linear/sdk";
import type { Config } from "../types.js";

export class LinearClientWrapper {
  private client: LinearClient;

  constructor(accessToken: string) {
    this.client = new LinearClient({ apiKey: accessToken });
  }

  async getIssue(issueId: string): Promise<Issue | null> {
    try {
      return await this.client.issue(issueId);
    } catch (error) {
      console.error(`Failed to fetch issue ${issueId}:`, error);
      return null;
    }
  }

  /**
   * Find the first "started" workflow state for a team, falling back to
   * the first "unstarted" state if none exists.
   */
  async getTeamActiveState(teamId: string): Promise<WorkflowState | null> {
    try {
      const team = await this.client.team(teamId);
      const states = await team.states();

      const started = states.nodes.find((s) => s.type === "started");
      if (started) return started;

      const unstarted = states.nodes.find((s) => s.type === "unstarted");
      return unstarted ?? null;
    } catch (error) {
      console.error(`Failed to fetch workflow states for team ${teamId}:`, error);
      return null;
    }
  }

  async reopenIssue(issueId: string, stateId: string): Promise<boolean> {
    try {
      const result = await this.client.updateIssue(issueId, { stateId });
      return result.success;
    } catch (error) {
      console.error(`Failed to reopen issue ${issueId}:`, error);
      return false;
    }
  }

  getRawClient(): LinearClient {
    return this.client;
  }
}

let clientInstance: LinearClientWrapper | null = null;

export function getLinearClient(config: Config): LinearClientWrapper {
  if (!clientInstance) {
    clientInstance = new LinearClientWrapper(config.linearAccessToken);
  }
  return clientInstance;
}
