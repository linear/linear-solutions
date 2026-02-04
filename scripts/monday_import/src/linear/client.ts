/**
 * Linear SDK client wrapper with rate limiting and caching
 */

import { LinearClient as LinearSDK, LinearDocument } from '@linear/sdk';
import type { 
  Team, 
  User, 
  WorkflowState, 
  IssueLabel, 
  Project,
  Issue,
} from '@linear/sdk';

// Import enum types from generated documents
const { IssueRelationType, ProjectUpdateHealthType } = LinearDocument;

export interface LabelInfo {
  id: string;
  name: string;
  isGroup: boolean;
  children: Map<string, string>; // name -> id
}

export interface WorkspaceConfig {
  teams: Map<string, { id: string; name: string; key: string }>;
  users: Map<string, string>; // name/email -> id
  projectStatuses: Map<string, string>; // name -> id
  issueStates: Map<string, string>; // name -> id
  projectLabels: Map<string, LabelInfo>;
  issueLabels: Map<string, LabelInfo>;
  existingProjects: Map<string, string>; // lowercase name -> id
  existingIssues: Map<string, Set<string>>; // projectId -> set of lowercase titles
}

export class LinearClientWrapper {
  private client: LinearSDK;
  private workspace: WorkspaceConfig | null = null;
  private apiCallCount = 0;
  private rateLimitMs: number;

  constructor(apiKey: string, rateLimitMs: number = 100) {
    this.client = new LinearSDK({ apiKey });
    this.rateLimitMs = rateLimitMs;
  }

  /**
   * Get the underlying SDK client
   */
  getClient(): LinearSDK {
    return this.client;
  }

  /**
   * Get the number of API calls made
   */
  getApiCallCount(): number {
    return this.apiCallCount;
  }

  /**
   * Rate limit delay
   */
  private async delay(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, this.rateLimitMs));
  }

  /**
   * Track API call
   */
  private track(): void {
    this.apiCallCount++;
  }

  /**
   * Discover workspace configuration
   */
  async discoverWorkspace(teamKeyOrId?: string): Promise<WorkspaceConfig> {
    console.log('  Discovering workspace configuration...');
    
    this.workspace = {
      teams: new Map(),
      users: new Map(),
      projectStatuses: new Map(),
      issueStates: new Map(),
      projectLabels: new Map(),
      issueLabels: new Map(),
      existingProjects: new Map(),
      existingIssues: new Map(),
    };

    // 1. Fetch teams
    console.log('    Fetching teams...');
    this.track();
    const teamsConnection = await this.client.teams();
    for (const team of teamsConnection.nodes) {
      this.workspace.teams.set(team.key, {
        id: team.id,
        name: team.name,
        key: team.key,
      });
      // Also map by ID
      this.workspace.teams.set(team.id, {
        id: team.id,
        name: team.name,
        key: team.key,
      });
    }

    // 2. Fetch users
    console.log('    Fetching users...');
    this.track();
    const usersConnection = await this.client.users();
    for (const user of usersConnection.nodes) {
      if (!user.active) continue;
      
      // Map by multiple keys for fuzzy matching
      if (user.name) {
        this.workspace.users.set(user.name, user.id);
        this.workspace.users.set(user.name.toLowerCase(), user.id);
      }
      if (user.displayName) {
        this.workspace.users.set(user.displayName, user.id);
        this.workspace.users.set(user.displayName.toLowerCase(), user.id);
      }
      if (user.email) {
        this.workspace.users.set(user.email, user.id);
        this.workspace.users.set(user.email.toLowerCase(), user.id);
        
        // Map by email prefix
        const prefix = user.email.split('@')[0].toLowerCase();
        this.workspace.users.set(prefix, user.id);
        
        // Handle firstname.lastname@domain.com
        if (prefix.includes('.')) {
          const parts = prefix.split('.');
          const fullName = parts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
          this.workspace.users.set(fullName, user.id);
          this.workspace.users.set(fullName.toLowerCase(), user.id);
        }
      }
    }

    // 3. Fetch project statuses
    console.log('    Fetching project statuses...');
    this.track();
    const statusesConnection = await this.client.projectStatuses();
    for (const status of statusesConnection.nodes) {
      this.workspace.projectStatuses.set(status.name, status.id);
    }

    // 4. Fetch issue labels (for issues/subitems)
    console.log('    Fetching issue labels...');
    this.track();
    const issueLabelsConnection = await this.client.issueLabels({ first: 250 });
    for (const label of issueLabelsConnection.nodes) {
      const children = new Map<string, string>();
      if (label.isGroup) {
        this.track();
        try {
          const childrenConnection = await label.children();
          for (const child of childrenConnection.nodes) {
            children.set(child.name, child.id);
            children.set(child.name.toLowerCase(), child.id);
          }
        } catch {
          // Some labels might not have children accessible
        }
      }
      
      const labelInfo = {
        id: label.id,
        name: label.name,
        isGroup: label.isGroup ?? false,
        children,
      };
      this.workspace.issueLabels.set(label.name, labelInfo);
      this.workspace.issueLabels.set(label.name.toLowerCase(), labelInfo);
    }

    // 5. Fetch project labels (separate from issue labels in Linear)
    console.log('    Fetching project labels...');
    await this.refreshProjectLabelsCache();

    // 6. Fetch issue states for target team
    if (teamKeyOrId) {
      const teamInfo = this.workspace.teams.get(teamKeyOrId);
      if (teamInfo) {
        console.log(`    Fetching issue states for team ${teamInfo.name}...`);
        this.track();
        const team = await this.client.team(teamInfo.id);
        this.track();
        const statesConnection = await team.states();
        for (const state of statesConnection.nodes) {
          this.workspace.issueStates.set(state.name, state.id);
          this.workspace.issueStates.set(state.name.toLowerCase(), state.id);
        }
      }
    }

    return this.workspace;
  }

  /**
   * Get the discovered workspace config
   */
  getWorkspace(): WorkspaceConfig | null {
    return this.workspace;
  }

  /**
   * Fetch existing projects for deduplication
   */
  async fetchExistingProjects(teamId: string): Promise<void> {
    if (!this.workspace) {
      throw new Error('Workspace not discovered. Call discoverWorkspace first.');
    }

    console.log('    Fetching existing projects for deduplication...');
    this.track();
    const team = await this.client.team(teamId);
    this.track();
    const projectsConnection = await team.projects({ first: 250 });
    
    let hasMore = true;
    let projects = projectsConnection;
    
    while (hasMore) {
      for (const project of projects.nodes) {
        this.workspace.existingProjects.set(project.name.toLowerCase().trim(), project.id);
      }
      
      hasMore = projects.pageInfo.hasNextPage;
      if (hasMore) {
        this.track();
        projects = await projects.fetchNext();
      }
    }

    console.log(`      Found ${this.workspace.existingProjects.size} existing projects`);
  }

  /**
   * Fetch existing issues for deduplication
   */
  async fetchExistingIssues(teamId: string): Promise<void> {
    if (!this.workspace) {
      throw new Error('Workspace not discovered. Call discoverWorkspace first.');
    }

    console.log('    Fetching existing issues for deduplication...');
    this.track();
    const team = await this.client.team(teamId);
    this.track();
    const issuesConnection = await team.issues({ first: 250 });
    
    let hasMore = true;
    let issues = issuesConnection;
    
    while (hasMore) {
      for (const issue of issues.nodes) {
        const projectId = (await issue.project)?.id ?? '_none';
        if (!this.workspace.existingIssues.has(projectId)) {
          this.workspace.existingIssues.set(projectId, new Set());
        }
        this.workspace.existingIssues.get(projectId)!.add(issue.title.toLowerCase().trim());
      }
      
      hasMore = issues.pageInfo.hasNextPage;
      if (hasMore) {
        this.track();
        issues = await issues.fetchNext();
      }
    }

    let totalIssues = 0;
    for (const titles of this.workspace.existingIssues.values()) {
      totalIssues += titles.size;
    }
    console.log(`      Found ${totalIssues} existing issues`);
  }

  /**
   * Resolve user ID from name/email
   */
  resolveUserId(nameOrEmail: string | null): string | null {
    if (!nameOrEmail || !this.workspace) return null;
    
    // Try exact match
    if (this.workspace.users.has(nameOrEmail)) {
      return this.workspace.users.get(nameOrEmail)!;
    }
    
    // Try lowercase
    const lower = nameOrEmail.toLowerCase();
    if (this.workspace.users.has(lower)) {
      return this.workspace.users.get(lower)!;
    }
    
    // Try partial match
    const normalized = lower.replace(/\s+/g, '').replace(/\./g, '');
    for (const [key, id] of this.workspace.users) {
      const normalizedKey = key.toLowerCase().replace(/\s+/g, '').replace(/\./g, '');
      if (normalized === normalizedKey || normalized.includes(normalizedKey) || normalizedKey.includes(normalized)) {
        return id;
      }
    }
    
    return null;
  }

  /**
   * Resolve status ID from name
   */
  resolveProjectStatusId(statusName: string | null): string | null {
    if (!statusName || !this.workspace) return null;
    return this.workspace.projectStatuses.get(statusName) ?? null;
  }

  /**
   * Resolve issue state ID from name
   */
  resolveIssueStateId(stateName: string | null): string | null {
    if (!stateName || !this.workspace) return null;
    return this.workspace.issueStates.get(stateName) ?? 
           this.workspace.issueStates.get(stateName.toLowerCase()) ?? 
           null;
  }

  /**
   * Create or get a project label group (project labels are separate from issue labels)
   */
  async getOrCreateProjectLabelGroup(groupName: string, _teamId?: string): Promise<string> {
    if (!this.workspace) {
      throw new Error('Workspace not discovered');
    }

    // Check cache (case-insensitive)
    const existing = this.workspace.projectLabels.get(groupName) || 
                     this.workspace.projectLabels.get(groupName.toLowerCase());
    if (existing) {
      if (existing.isGroup) {
        console.log(`      ✓ Using existing project label group: ${groupName}`);
        return existing.id;
      } else {
        throw new Error(
          `Project label "${groupName}" already exists but is not a label group. ` +
          `Please delete or rename this label in Linear before running the import.`
        );
      }
    }

    // Create new project label group
    console.log(`      Creating project label group: ${groupName}`);
    this.track();
    await this.delay();
    
    try {
      const result = await this.client.client.request<
        { projectLabelCreate: { success: boolean; projectLabel: { id: string; name: string } | null } },
        { input: { name: string; isGroup: boolean } }
      >(`
        mutation CreateProjectLabelGroup($input: ProjectLabelCreateInput!) {
          projectLabelCreate(input: $input) {
            success
            projectLabel {
              id
              name
            }
          }
        }
      `, { input: { name: groupName, isGroup: true } });
      
      const label = result.projectLabelCreate?.projectLabel;
      if (label) {
        const labelInfo = {
          id: label.id,
          name: label.name,
          isGroup: true,
          children: new Map<string, string>(),
        };
        this.workspace.projectLabels.set(groupName, labelInfo);
        this.workspace.projectLabels.set(groupName.toLowerCase(), labelInfo);
        console.log(`      ✓ Created project label group: ${groupName}`);
        return label.id;
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      
      if (errorMsg.toLowerCase().includes('duplicate') || errorMsg.toLowerCase().includes('already exists')) {
        console.log(`      Project label already exists, checking if it's a group...`);
        await this.refreshProjectLabelsCache();
        
        const found = this.workspace.projectLabels.get(groupName) || 
                      this.workspace.projectLabels.get(groupName.toLowerCase());
        if (found) {
          if (found.isGroup) {
            console.log(`      ✓ Using existing project label group: ${groupName}`);
            return found.id;
          } else {
            throw new Error(
              `Project label "${groupName}" already exists but is not a label group. ` +
              `Please delete or rename this label in Linear before running the import.`
            );
          }
        }
      }
      
      throw new Error(`Failed to create project label group "${groupName}": ${errorMsg}`);
    }

    throw new Error(`Failed to create project label group: ${groupName}`);
  }

  /**
   * Create or get a project label under a group
   */
  async getOrCreateProjectLabel(labelName: string, groupId?: string, _teamId?: string): Promise<string> {
    if (!this.workspace) {
      throw new Error('Workspace not discovered');
    }

    // If group ID provided, check in group's children first
    if (groupId) {
      for (const labelInfo of this.workspace.projectLabels.values()) {
        if (labelInfo.id === groupId) {
          const childId = labelInfo.children.get(labelName) || 
                          labelInfo.children.get(labelName.toLowerCase());
          if (childId) {
            console.log(`      ✓ Using existing project label: ${labelName}`);
            return childId;
          }
        }
      }
    }

    // Check for standalone label with same name
    const existing = this.workspace.projectLabels.get(labelName) ||
                     this.workspace.projectLabels.get(labelName.toLowerCase());
    if (existing && !existing.isGroup) {
      console.log(`      ✓ Using existing project label: ${labelName}`);
      return existing.id;
    }

    // Create new project label
    console.log(`      Creating project label: ${labelName}`);
    this.track();
    await this.delay();
    
    try {
      const input: { name: string; parentId?: string } = { name: labelName };
      if (groupId) input.parentId = groupId;
      
      const result = await this.client.client.request<
        { projectLabelCreate: { success: boolean; projectLabel: { id: string; name: string } | null } },
        { input: { name: string; parentId?: string } }
      >(`
        mutation CreateProjectLabel($input: ProjectLabelCreateInput!) {
          projectLabelCreate(input: $input) {
            success
            projectLabel {
              id
              name
            }
          }
        }
      `, { input });
      
      const label = result.projectLabelCreate?.projectLabel;
      if (label) {
        const labelInfo = {
          id: label.id,
          name: label.name,
          isGroup: false,
          children: new Map<string, string>(),
        };
        
        if (groupId) {
          for (const groupInfo of this.workspace.projectLabels.values()) {
            if (groupInfo.id === groupId) {
              groupInfo.children.set(labelName, label.id);
              groupInfo.children.set(labelName.toLowerCase(), label.id);
              break;
            }
          }
        } else {
          this.workspace.projectLabels.set(labelName, labelInfo);
          this.workspace.projectLabels.set(labelName.toLowerCase(), labelInfo);
        }
        console.log(`      ✓ Created project label: ${labelName}`);
        return label.id;
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      
      const isDuplicate = errorMsg.toLowerCase().includes('duplicate') || errorMsg.toLowerCase().includes('already exists');
      
      if (isDuplicate) {
        console.log(`      Project label already exists, looking up...`);
        await this.refreshProjectLabelsCache();
        
        // Check in group's children first
        if (groupId) {
          for (const labelInfo of this.workspace.projectLabels.values()) {
            if (labelInfo.id === groupId) {
              const childId = labelInfo.children.get(labelName) || 
                              labelInfo.children.get(labelName.toLowerCase());
              if (childId) {
                console.log(`      ✓ Using existing project label: ${labelName}`);
                return childId;
              }
            }
          }
        }
        
        // Check for standalone label
        const found = this.workspace.projectLabels.get(labelName) ||
                      this.workspace.projectLabels.get(labelName.toLowerCase());
        if (found && !found.isGroup) {
          console.log(`      ✓ Using existing project label: ${labelName}`);
          return found.id;
        }
        
        throw new Error(
          `Project label "${labelName}" already exists but not in the expected group. ` +
          `Please clean up your labels in Linear before running the import.`
        );
      }
      
      if (errorMsg.toLowerCase().includes('parent label is not a group')) {
        throw new Error(
          `Cannot add "${labelName}" to parent label because the parent is not a label group. ` +
          `Please ensure the parent label is configured as a group in Linear, or delete it before running the import.`
        );
      }
      
      throw new Error(`Failed to create project label "${labelName}": ${errorMsg}`);
    }

    throw new Error(`Failed to create project label: ${labelName}`);
  }

  /**
   * Refresh issue labels cache from Linear
   */
  private async refreshIssueLabelsCache(): Promise<void> {
    if (!this.workspace) return;
    
    this.track();
    const labelsConnection = await this.client.issueLabels({ first: 250 });
    
    for (const label of labelsConnection.nodes) {
      const children = new Map<string, string>();
      if (label.isGroup) {
        this.track();
        try {
          const childrenConnection = await label.children();
          for (const child of childrenConnection.nodes) {
            children.set(child.name, child.id);
            children.set(child.name.toLowerCase(), child.id);
          }
        } catch {
          // Some labels might not have children accessible
        }
      }
      
      const labelInfo = {
        id: label.id,
        name: label.name,
        isGroup: label.isGroup ?? false,
        children,
      };
      this.workspace.issueLabels.set(label.name, labelInfo);
      this.workspace.issueLabels.set(label.name.toLowerCase(), labelInfo);
    }
  }

  /**
   * Refresh project labels cache from Linear (project labels are separate from issue labels)
   */
  private async refreshProjectLabelsCache(): Promise<void> {
    if (!this.workspace) return;
    
    this.track();
    // Use raw GraphQL to fetch project labels
    const result = await this.client.client.request<{
      projectLabels: { nodes: Array<{ id: string; name: string; isGroup: boolean; children: { nodes: Array<{ id: string; name: string }> } }> }
    }, Record<string, never>>(`
      query {
        projectLabels {
          nodes {
            id
            name
            isGroup
            children {
              nodes {
                id
                name
              }
            }
          }
        }
      }
    `, {});
    
    for (const label of result.projectLabels.nodes) {
      const children = new Map<string, string>();
      if (label.isGroup && label.children?.nodes) {
        for (const child of label.children.nodes) {
          children.set(child.name, child.id);
          children.set(child.name.toLowerCase(), child.id);
        }
      }
      
      const labelInfo = {
        id: label.id,
        name: label.name,
        isGroup: label.isGroup ?? false,
        children,
      };
      this.workspace.projectLabels.set(label.name, labelInfo);
      this.workspace.projectLabels.set(label.name.toLowerCase(), labelInfo);
    }
  }

  /**
   * Create or get an issue label group
   * Note: Label groups are created at workspace level (no teamId)
   */
  async getOrCreateIssueLabelGroup(groupName: string, _teamId?: string): Promise<string> {
    if (!this.workspace) {
      throw new Error('Workspace not discovered');
    }

    // Check cache (case-insensitive)
    const existing = this.workspace.issueLabels.get(groupName) || 
                     this.workspace.issueLabels.get(groupName.toLowerCase());
    if (existing) {
      if (existing.isGroup) {
        console.log(`      ✓ Using existing label group: ${groupName}`);
        return existing.id;
      } else {
        // Label exists but is not a group - this is a conflict
        throw new Error(
          `Label "${groupName}" already exists but is not a label group. ` +
          `Please delete or rename this label in Linear before running the import.`
        );
      }
    }

    // Try to create new label group at workspace level with isGroup: true
    console.log(`      Creating label group: ${groupName}`);
    this.track();
    await this.delay();
    
    try {
      // Use raw GraphQL to create label with isGroup: true
      const result = await this.client.client.request<
        { issueLabelCreate: { success: boolean; issueLabel: { id: string; name: string } | null } },
        { input: { name: string; isGroup: boolean } }
      >(`
        mutation CreateLabelGroup($input: IssueLabelCreateInput!) {
          issueLabelCreate(input: $input) {
            success
            issueLabel {
              id
              name
            }
          }
        }
      `, { input: { name: groupName, isGroup: true } });
      
      const label = result.issueLabelCreate?.issueLabel;
      if (label) {
        const labelInfo = {
          id: label.id,
          name: label.name,
          isGroup: true,
          children: new Map<string, string>(),
        };
        this.workspace.issueLabels.set(groupName, labelInfo);
        this.workspace.issueLabels.set(groupName.toLowerCase(), labelInfo);
        this.workspace.projectLabels.set(groupName, labelInfo);
        this.workspace.projectLabels.set(groupName.toLowerCase(), labelInfo);
        console.log(`      ✓ Created label group: ${groupName}`);
        return label.id;
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      
      // Check if it's a duplicate error
      if (errorMsg.toLowerCase().includes('duplicate') || errorMsg.toLowerCase().includes('already exists')) {
        console.log(`      Label already exists, checking if it's a group...`);
        await this.refreshIssueLabelsCache();
        
        const found = this.workspace.issueLabels.get(groupName) || 
                      this.workspace.issueLabels.get(groupName.toLowerCase());
        if (found) {
          if (found.isGroup) {
            console.log(`      ✓ Using existing label group: ${groupName}`);
            return found.id;
          } else {
            // Label exists but is not a group - conflict
            throw new Error(
              `Label "${groupName}" already exists but is not a label group. ` +
              `Please delete or rename this label in Linear before running the import.`
            );
          }
        }
      }
      
      // Other error
      throw new Error(`Failed to create label group "${groupName}": ${errorMsg}`);
    }

    throw new Error(`Failed to create label group: ${groupName}`);
  }

  /**
   * Create or get an issue label under a group
   * Note: Labels are created at workspace level (no teamId), with optional parentId for grouping
   */
  async getOrCreateIssueLabel(labelName: string, groupId?: string, _teamId?: string): Promise<string> {
    if (!this.workspace) {
      throw new Error('Workspace not discovered');
    }

    // If group ID provided, check in group's children first
    if (groupId) {
      for (const labelInfo of this.workspace.issueLabels.values()) {
        if (labelInfo.id === groupId) {
          const childId = labelInfo.children.get(labelName) || 
                          labelInfo.children.get(labelName.toLowerCase());
          if (childId) {
            console.log(`      ✓ Using existing label: ${labelName}`);
            return childId;
          }
        }
      }
    }

    // Check for standalone label with same name
    const existing = this.workspace.issueLabels.get(labelName) ||
                     this.workspace.issueLabels.get(labelName.toLowerCase());
    if (existing && !existing.isGroup) {
      console.log(`      ✓ Using existing label: ${labelName}`);
      return existing.id;
    }

    // Create new label at workspace level (no teamId)
    console.log(`      Creating label: ${labelName}`);
    this.track();
    await this.delay();
    
    const input: { name: string; parentId?: string } = { name: labelName };
    if (groupId) input.parentId = groupId;
    
    try {
      const result = await this.client.createIssueLabel(input);

      const label = await result.issueLabel;
      if (label) {
        const labelInfo = {
          id: label.id,
          name: label.name,
          isGroup: false,
          children: new Map<string, string>(),
        };
        
        if (groupId) {
          // Add to parent's children
          for (const groupInfo of this.workspace.issueLabels.values()) {
            if (groupInfo.id === groupId) {
              groupInfo.children.set(labelName, label.id);
              groupInfo.children.set(labelName.toLowerCase(), label.id);
              break;
            }
          }
        } else {
          this.workspace.issueLabels.set(labelName, labelInfo);
          this.workspace.issueLabels.set(labelName.toLowerCase(), labelInfo);
          this.workspace.projectLabels.set(labelName, labelInfo);
          this.workspace.projectLabels.set(labelName.toLowerCase(), labelInfo);
        }
        console.log(`      ✓ Created label: ${labelName}`);
        return label.id;
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      
      // Check if it's a duplicate error
      const isDuplicate = errorMsg.toLowerCase().includes('duplicate') || errorMsg.toLowerCase().includes('already exists');
      
      if (isDuplicate) {
        console.log(`      Label already exists, looking up...`);
        await this.refreshIssueLabelsCache();
        
        // Check in group's children first
        if (groupId) {
          for (const labelInfo of this.workspace.issueLabels.values()) {
            if (labelInfo.id === groupId) {
              const childId = labelInfo.children.get(labelName) || 
                              labelInfo.children.get(labelName.toLowerCase());
              if (childId) {
                console.log(`      ✓ Using existing label: ${labelName}`);
                return childId;
              }
            }
          }
        }
        
        // Check for standalone label
        const found = this.workspace.issueLabels.get(labelName) ||
                      this.workspace.issueLabels.get(labelName.toLowerCase());
        if (found && !found.isGroup) {
          console.log(`      ✓ Using existing label: ${labelName}`);
          return found.id;
        }
        
        // Label exists somewhere but not where we expect - conflict
        throw new Error(
          `Label "${labelName}" already exists but not in the expected group. ` +
          `Please clean up your labels in Linear before running the import.`
        );
      }
      
      // Check if parent isn't a group
      if (errorMsg.toLowerCase().includes('parent label is not a group')) {
        throw new Error(
          `Cannot add "${labelName}" to parent label because the parent is not a label group. ` +
          `Please ensure the parent label is configured as a group in Linear, or delete it before running the import.`
        );
      }
      
      // Other error
      throw new Error(`Failed to create label "${labelName}": ${errorMsg}`);
    }

    throw new Error(`Failed to create label: ${labelName}`);
  }

  /**
   * Create a project
   * Note: Projects don't support labelIds via SDK - labels must be added separately
   */
  async createProject(input: {
    name: string;
    description?: string;
    teamIds: string[];
    statusId?: string;
    priority?: number;
    startDate?: string;
    targetDate?: string;
    leadId?: string;
  }): Promise<{ id: string; url: string }> {
    this.track();
    await this.delay();
    
    const createInput: {
      name: string;
      teamIds: string[];
      description?: string;
      statusId?: string;
      priority?: number;
      startDate?: string;
      targetDate?: string;
      leadId?: string;
    } = {
      name: input.name,
      teamIds: input.teamIds,
    };
    
    if (input.description) createInput.description = input.description;
    if (input.statusId) createInput.statusId = input.statusId;
    if (input.priority !== undefined) createInput.priority = input.priority;
    if (input.startDate) createInput.startDate = input.startDate;
    if (input.targetDate) createInput.targetDate = input.targetDate;
    if (input.leadId) createInput.leadId = input.leadId;
    
    const result = await this.client.createProject(createInput);

    const project = await result.project;
    if (project) {
      // Update cache
      if (this.workspace) {
        this.workspace.existingProjects.set(input.name.toLowerCase().trim(), project.id);
      }
      return { id: project.id, url: project.url };
    }

    throw new Error(`Failed to create project: ${input.name}`);
  }

  /**
   * Update a project (e.g., to add members)
   */
  async updateProject(projectId: string, input: {
    memberIds?: string[];
  }): Promise<void> {
    this.track();
    await this.delay();
    await this.client.updateProject(projectId, input);
  }

  /**
   * Add a label to a project
   */
  async addLabelToProject(projectId: string, labelId: string): Promise<void> {
    this.track();
    await this.delay();
    
    await this.client.client.request<
      { projectAddLabel: { success: boolean } },
      { id: string; labelId: string }
    >(`
      mutation AddLabelToProject($id: String!, $labelId: String!) {
        projectAddLabel(id: $id, labelId: $labelId) {
          success
        }
      }
    `, { id: projectId, labelId });
  }

  /**
   * Add multiple labels to a project
   */
  async addLabelsToProject(projectId: string, labelIds: string[]): Promise<void> {
    for (const labelId of labelIds) {
      try {
        await this.addLabelToProject(projectId, labelId);
      } catch (error) {
        // Log but don't fail - label might already be applied or be a group label
        const errorMsg = error instanceof Error ? error.message : String(error);
        if (!errorMsg.includes('already') && !errorMsg.includes('group')) {
          console.log(`      Warning: Could not add label ${labelId} to project: ${errorMsg}`);
        }
      }
    }
  }

  /**
   * Create a project update (health/status update)
   */
  async createProjectUpdate(input: {
    projectId: string;
    body: string;
    health?: 'onTrack' | 'atRisk' | 'offTrack';
  }): Promise<void> {
    this.track();
    await this.delay();
    
    const createInput: {
      projectId: string;
      body: string;
      health?: LinearDocument.ProjectUpdateHealthType;
    } = {
      projectId: input.projectId,
      body: input.body,
    };
    
    if (input.health) {
      const healthMap: Record<string, LinearDocument.ProjectUpdateHealthType> = {
        'onTrack': ProjectUpdateHealthType.OnTrack,
        'atRisk': ProjectUpdateHealthType.AtRisk,
        'offTrack': ProjectUpdateHealthType.OffTrack,
      };
      createInput.health = healthMap[input.health];
    }
    
    await this.client.createProjectUpdate(createInput);
  }

  /**
   * Create an issue
   */
  async createIssue(input: {
    title: string;
    description?: string;
    teamId: string;
    projectId?: string;
    stateId?: string;
    assigneeId?: string;
    priority?: number;
    estimate?: number;
    labelIds?: string[];
    dueDate?: string;
    parentId?: string;
  }): Promise<{ id: string; identifier: string; url: string }> {
    this.track();
    await this.delay();
    
    const result = await this.client.createIssue({
      title: input.title,
      description: input.description,
      teamId: input.teamId,
      projectId: input.projectId,
      stateId: input.stateId,
      assigneeId: input.assigneeId,
      priority: input.priority,
      estimate: input.estimate,
      labelIds: input.labelIds,
      dueDate: input.dueDate,
      parentId: input.parentId,
    });

    const issue = await result.issue;
    if (issue) {
      // Update cache
      if (this.workspace) {
        const projectId = input.projectId ?? '_none';
        if (!this.workspace.existingIssues.has(projectId)) {
          this.workspace.existingIssues.set(projectId, new Set());
        }
        this.workspace.existingIssues.get(projectId)!.add(input.title.toLowerCase().trim());
      }
      return { id: issue.id, identifier: issue.identifier, url: issue.url };
    }

    throw new Error(`Failed to create issue: ${input.title}`);
  }

  /**
   * Create a comment on an issue
   */
  async createComment(issueId: string, body: string): Promise<void> {
    this.track();
    await this.delay();
    await this.client.createComment({
      issueId,
      body,
    });
  }

  /**
   * Create an attachment (link) on an issue
   */
  async createAttachment(issueId: string, url: string, title: string): Promise<void> {
    this.track();
    await this.delay();
    await this.client.createAttachment({
      issueId,
      url,
      title,
    });
  }

  /**
   * Create issue relation (dependency)
   */
  async createIssueRelation(
    issueId: string, 
    relatedIssueId: string, 
    type: 'blocks' | 'duplicate' | 'related'
  ): Promise<void> {
    this.track();
    await this.delay();
    
    const typeMap: Record<string, LinearDocument.IssueRelationType> = {
      'blocks': IssueRelationType.Blocks,
      'duplicate': IssueRelationType.Duplicate,
      'related': IssueRelationType.Related,
    };
    
    await this.client.createIssueRelation({
      issueId,
      relatedIssueId,
      type: typeMap[type],
    });
  }
}
