/**
 * Webhook Filtering Patterns
 *
 * This guide demonstrates common patterns for filtering webhook events
 * to react only to changes you care about.
 *
 * These are standalone functions you can use in your webhook handler.
 */

// =============================================================================
// TYPES
// =============================================================================

interface WebhookPayload {
  action: "create" | "update" | "remove";
  type: string;
  data: Record<string, unknown>;
  updatedFrom?: Record<string, unknown>;
  webhookId: string;
}

interface IssueData {
  id: string;
  identifier: string;
  title: string;
  stateId: string;
  assigneeId: string | null;
  priority: number;
  labelIds: string[];
  teamId: string;
  projectId: string | null;
  cycleId: string | null;
}

// =============================================================================
// FILTER: BY ACTION
// =============================================================================

/**
 * Filter to only process specific actions.
 */
function isCreate(payload: WebhookPayload): boolean {
  return payload.action === "create";
}

function isUpdate(payload: WebhookPayload): boolean {
  return payload.action === "update";
}

function isRemove(payload: WebhookPayload): boolean {
  return payload.action === "remove";
}

// =============================================================================
// FILTER: BY RESOURCE TYPE
// =============================================================================

/**
 * Filter to only process specific resource types.
 */
function isIssue(payload: WebhookPayload): payload is WebhookPayload & { data: IssueData } {
  return payload.type === "Issue";
}

function isComment(payload: WebhookPayload): boolean {
  return payload.type === "Comment";
}

function isProject(payload: WebhookPayload): boolean {
  return payload.type === "Project";
}

// =============================================================================
// FILTER: BY FIELD CHANGE
// =============================================================================

/**
 * Check if a specific field changed in an update.
 *
 * The `updatedFrom` object contains the PREVIOUS values of fields that changed.
 * If a field is in `updatedFrom`, it was modified.
 */
function fieldChanged(payload: WebhookPayload, field: string): boolean {
  if (payload.action !== "update") return false;
  if (!payload.updatedFrom) return false;
  return field in payload.updatedFrom;
}

/**
 * Check if state changed (workflow state transition).
 */
function stateChanged(payload: WebhookPayload): boolean {
  return fieldChanged(payload, "stateId");
}

/**
 * Check if assignee changed.
 */
function assigneeChanged(payload: WebhookPayload): boolean {
  return fieldChanged(payload, "assigneeId");
}

/**
 * Check if priority changed.
 */
function priorityChanged(payload: WebhookPayload): boolean {
  return fieldChanged(payload, "priority");
}

/**
 * Check if labels changed.
 */
function labelsChanged(payload: WebhookPayload): boolean {
  return fieldChanged(payload, "labelIds");
}

// =============================================================================
// FILTER: BY TEAM
// =============================================================================

/**
 * Filter to only process events from specific teams.
 */
function isFromTeam(payload: WebhookPayload, teamId: string): boolean {
  return (payload.data as IssueData).teamId === teamId;
}

function isFromAnyTeam(payload: WebhookPayload, teamIds: string[]): boolean {
  return teamIds.includes((payload.data as IssueData).teamId);
}

// =============================================================================
// FILTER: BY LABEL
// =============================================================================

/**
 * Check if issue has a specific label.
 */
function hasLabel(payload: WebhookPayload, labelId: string): boolean {
  const labelIds = (payload.data as IssueData).labelIds || [];
  return labelIds.includes(labelId);
}

/**
 * Check if issue has any of the specified labels.
 */
function hasAnyLabel(payload: WebhookPayload, labelIds: string[]): boolean {
  const issueLabelIds = (payload.data as IssueData).labelIds || [];
  return labelIds.some((id) => issueLabelIds.includes(id));
}

/**
 * Check if a specific label was added in this update.
 */
function labelAdded(payload: WebhookPayload, labelId: string): boolean {
  if (!labelsChanged(payload)) return false;

  const previousLabels = (payload.updatedFrom?.labelIds as string[]) || [];
  const currentLabels = (payload.data as IssueData).labelIds || [];

  return !previousLabels.includes(labelId) && currentLabels.includes(labelId);
}

/**
 * Check if a specific label was removed in this update.
 */
function labelRemoved(payload: WebhookPayload, labelId: string): boolean {
  if (!labelsChanged(payload)) return false;

  const previousLabels = (payload.updatedFrom?.labelIds as string[]) || [];
  const currentLabels = (payload.data as IssueData).labelIds || [];

  return previousLabels.includes(labelId) && !currentLabels.includes(labelId);
}

// =============================================================================
// FILTER: BY STATE TYPE
// =============================================================================

/**
 * Check if issue moved to a specific state.
 *
 * NOTE: You'll need to know the state UUID. Query your team's workflow states
 * to find the IDs for states you care about.
 */
function movedToState(payload: WebhookPayload, stateId: string): boolean {
  if (!stateChanged(payload)) return false;
  return (payload.data as IssueData).stateId === stateId;
}

/**
 * Check if issue moved from a specific state.
 */
function movedFromState(payload: WebhookPayload, stateId: string): boolean {
  if (!stateChanged(payload)) return false;
  return payload.updatedFrom?.stateId === stateId;
}

// =============================================================================
// FILTER: BY PRIORITY
// =============================================================================

/**
 * Check if priority increased (became more urgent).
 * Lower number = higher priority (1 is urgent, 4 is low).
 */
function priorityIncreased(payload: WebhookPayload): boolean {
  if (!priorityChanged(payload)) return false;

  const oldPriority = payload.updatedFrom?.priority as number;
  const newPriority = (payload.data as IssueData).priority;

  return newPriority < oldPriority;
}

/**
 * Check if issue became urgent (priority 1).
 */
function becameUrgent(payload: WebhookPayload): boolean {
  if (!priorityChanged(payload)) return false;

  const newPriority = (payload.data as IssueData).priority;
  return newPriority === 1;
}

// =============================================================================
// FILTER: BY ASSIGNMENT
// =============================================================================

/**
 * Check if issue was assigned (had no assignee, now has one).
 */
function wasAssigned(payload: WebhookPayload): boolean {
  if (!assigneeChanged(payload)) return false;

  const oldAssignee = payload.updatedFrom?.assigneeId;
  const newAssignee = (payload.data as IssueData).assigneeId;

  return !oldAssignee && !!newAssignee;
}

/**
 * Check if issue was unassigned.
 */
function wasUnassigned(payload: WebhookPayload): boolean {
  if (!assigneeChanged(payload)) return false;

  const oldAssignee = payload.updatedFrom?.assigneeId;
  const newAssignee = (payload.data as IssueData).assigneeId;

  return !!oldAssignee && !newAssignee;
}

/**
 * Check if issue was assigned to a specific user.
 */
function assignedTo(payload: WebhookPayload, userId: string): boolean {
  if (!assigneeChanged(payload)) return false;
  return (payload.data as IssueData).assigneeId === userId;
}

// =============================================================================
// EXAMPLE: COMBINING FILTERS
// =============================================================================

/**
 * Example: Only process urgent issues created in a specific team.
 */
function exampleCombinedFilter(payload: WebhookPayload): boolean {
  const targetTeamId = "<YOUR_TEAM_ID>";

  return (
    isIssue(payload) &&
    isCreate(payload) &&
    isFromTeam(payload, targetTeamId) &&
    (payload.data as IssueData).priority === 1
  );
}

/**
 * Example: Notify when high-priority issues are assigned.
 */
function exampleAssignmentNotification(payload: WebhookPayload): boolean {
  return (
    isIssue(payload) &&
    isUpdate(payload) &&
    wasAssigned(payload) &&
    (payload.data as IssueData).priority <= 2 // Urgent or High
  );
}

/**
 * Example: Trigger CI when issue moves to "In Progress".
 */
function exampleStateTransition(payload: WebhookPayload): boolean {
  const inProgressStateId = "<YOUR_IN_PROGRESS_STATE_ID>";

  return (
    isIssue(payload) &&
    isUpdate(payload) &&
    movedToState(payload, inProgressStateId)
  );
}
