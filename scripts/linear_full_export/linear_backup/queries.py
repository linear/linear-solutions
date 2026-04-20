"""GraphQL query strings for the Linear backup.

Each query:
- accepts `$first`, `$after`, and a `$filter` of the matching *Filter type
- selects scalar fields plus IDs of related entities (no deep nesting)
- returns a standard `nodes` + `pageInfo` connection payload

Related entities (comments, attachments, project updates, ...) are pulled via
their own top-level queries rather than nested under issues/projects, which
keeps per-request complexity low and lets each entity use its own updatedAt
filter for incremental mode.
"""

_PAGE_INFO = "pageInfo { hasNextPage endCursor }"


ISSUES_QUERY = f"""
query Issues($first: Int!, $after: String, $filter: IssueFilter) {{
  issues(first: $first, after: $after, filter: $filter, includeArchived: true) {{
    nodes {{
      id
      identifier
      number
      title
      description
      url
      priority
      priorityLabel
      estimate
      sortOrder
      boardOrder
      branchName
      customerTicketCount
      trashed
      createdAt
      updatedAt
      archivedAt
      startedAt
      completedAt
      canceledAt
      autoClosedAt
      autoArchivedAt
      dueDate
      snoozedUntilAt
      team {{ id key name }}
      state {{ id name type }}
      creator {{ id }}
      assignee {{ id }}
      snoozedBy {{ id }}
      parent {{ id }}
      project {{ id }}
      projectMilestone {{ id }}
      cycle {{ id }}
      subscribers {{ nodes {{ id }} }}
      labels {{ nodes {{ id name }} }}
    }}
    {_PAGE_INFO}
  }}
}}
"""


PROJECTS_QUERY = f"""
query Projects($first: Int!, $after: String, $filter: ProjectFilter) {{
  projects(first: $first, after: $after, filter: $filter, includeArchived: true) {{
    nodes {{
      id
      name
      description
      content
      slugId
      url
      color
      icon
      priority
      priorityLabel
      progress
      scope
      sortOrder
      health
      state
      trashed
      createdAt
      updatedAt
      archivedAt
      startDate
      targetDate
      startedAt
      completedAt
      canceledAt
      autoArchivedAt
      creator {{ id }}
      lead {{ id }}
      convertedFromIssue {{ id }}
      status {{ id name type }}
    }}
    {_PAGE_INFO}
  }}
}}
"""


# Project milestones are pulled as their own top-level connection so the
# per-project complexity stays well under Linear's 10k budget.
PROJECT_MILESTONES_QUERY = f"""
query ProjectMilestones($first: Int!, $after: String, $filter: ProjectMilestoneFilter) {{
  projectMilestones(first: $first, after: $after, filter: $filter) {{
    nodes {{
      id
      name
      description
      sortOrder
      targetDate
      createdAt
      updatedAt
      archivedAt
      project {{ id }}
    }}
    {_PAGE_INFO}
  }}
}}
"""


INITIATIVES_QUERY = f"""
query Initiatives($first: Int!, $after: String, $filter: InitiativeFilter) {{
  initiatives(first: $first, after: $after, filter: $filter) {{
    nodes {{
      id
      name
      description
      slugId
      color
      icon
      sortOrder
      status
      targetDate
      targetDateResolution
      createdAt
      updatedAt
      archivedAt
      creator {{ id }}
      owner {{ id }}
      projects {{ nodes {{ id }} }}
    }}
    {_PAGE_INFO}
  }}
}}
"""


TEAMS_QUERY = f"""
query Teams($first: Int!, $after: String, $filter: TeamFilter) {{
  teams(first: $first, after: $after, filter: $filter, includeArchived: true) {{
    nodes {{
      id
      key
      name
      description
      icon
      color
      private
      timezone
      issueEstimationType
      defaultIssueEstimate
      triageEnabled
      cyclesEnabled
      cycleDuration
      cycleStartDay
      cycleCooldownTime
      cycleIssueAutoAssignStarted
      cycleIssueAutoAssignCompleted
      cycleLockToActive
      upcomingCycleCount
      autoArchivePeriod
      autoClosePeriod
      autoCloseStateId
      inviteHash
      createdAt
      updatedAt
      archivedAt
      parent {{ id }}
      organization {{ id }}
      defaultIssueState {{ id }}
      draftWorkflowState {{ id }}
      startWorkflowState {{ id }}
      reviewWorkflowState {{ id }}
      markedAsDuplicateWorkflowState {{ id }}
      mergeWorkflowState {{ id }}
      triageIssueState {{ id }}
    }}
    {_PAGE_INFO}
  }}
}}
"""


USERS_QUERY = f"""
query Users($first: Int!, $after: String, $filter: UserFilter) {{
  users(first: $first, after: $after, filter: $filter, includeArchived: true) {{
    nodes {{
      id
      name
      displayName
      email
      avatarUrl
      description
      statusEmoji
      statusLabel
      statusUntilAt
      timezone
      admin
      guest
      active
      isMe
      createdAt
      updatedAt
      archivedAt
      lastSeen
      organization {{ id }}
    }}
    {_PAGE_INFO}
  }}
}}
"""


LABELS_QUERY = f"""
query IssueLabels($first: Int!, $after: String, $filter: IssueLabelFilter) {{
  issueLabels(first: $first, after: $after, filter: $filter, includeArchived: true) {{
    nodes {{
      id
      name
      description
      color
      createdAt
      updatedAt
      archivedAt
      team {{ id }}
      parent {{ id }}
      creator {{ id }}
    }}
    {_PAGE_INFO}
  }}
}}
"""


WORKFLOW_STATES_QUERY = f"""
query WorkflowStates($first: Int!, $after: String, $filter: WorkflowStateFilter) {{
  workflowStates(first: $first, after: $after, filter: $filter, includeArchived: true) {{
    nodes {{
      id
      name
      description
      color
      position
      type
      createdAt
      updatedAt
      archivedAt
      team {{ id }}
    }}
    {_PAGE_INFO}
  }}
}}
"""


CYCLES_QUERY = f"""
query Cycles($first: Int!, $after: String, $filter: CycleFilter) {{
  cycles(first: $first, after: $after, filter: $filter, includeArchived: true) {{
    nodes {{
      id
      name
      description
      number
      startsAt
      endsAt
      completedAt
      autoArchivedAt
      progress
      scopeHistory
      completedScopeHistory
      issueCountHistory
      completedIssueCountHistory
      createdAt
      updatedAt
      archivedAt
      team {{ id }}
    }}
    {_PAGE_INFO}
  }}
}}
"""


COMMENTS_QUERY = f"""
query Comments($first: Int!, $after: String, $filter: CommentFilter) {{
  comments(first: $first, after: $after, filter: $filter) {{
    nodes {{
      id
      body
      url
      editedAt
      createdAt
      updatedAt
      archivedAt
      user {{ id }}
      issue {{ id }}
      parent {{ id }}
      resolvedAt
      resolvingUser {{ id }}
      projectUpdate {{ id }}
    }}
    {_PAGE_INFO}
  }}
}}
"""


PROJECT_UPDATES_QUERY = f"""
query ProjectUpdates($first: Int!, $after: String, $filter: ProjectUpdateFilter) {{
  projectUpdates(first: $first, after: $after, filter: $filter) {{
    nodes {{
      id
      body
      health
      url
      editedAt
      createdAt
      updatedAt
      archivedAt
      user {{ id }}
      project {{ id }}
    }}
    {_PAGE_INFO}
  }}
}}
"""


# Linear exposes initiative updates as `initiativeUpdates` (if enabled for the
# workspace). We wrap the call so a schema mismatch (e.g. older workspace)
# degrades to an empty result rather than aborting the whole backup.
INITIATIVE_UPDATES_QUERY = f"""
query InitiativeUpdates($first: Int!, $after: String, $filter: InitiativeUpdateFilter) {{
  initiativeUpdates(first: $first, after: $after, filter: $filter) {{
    nodes {{
      id
      body
      health
      url
      editedAt
      createdAt
      updatedAt
      archivedAt
      user {{ id }}
      initiative {{ id }}
    }}
    {_PAGE_INFO}
  }}
}}
"""


ATTACHMENTS_QUERY = f"""
query Attachments($first: Int!, $after: String, $filter: AttachmentFilter) {{
  attachments(first: $first, after: $after, filter: $filter) {{
    nodes {{
      id
      title
      subtitle
      url
      sourceType
      groupBySource
      metadata
      createdAt
      updatedAt
      archivedAt
      creator {{ id }}
      issue {{ id }}
    }}
    {_PAGE_INFO}
  }}
}}
"""


# Ordered list of (entity_key, filename, query_string, connection_path)
# used by the backup orchestrator. The key also shows up in the incremental
# audit file and the manifest counts.
ENTITIES: list[tuple[str, str, str, list[str]]] = [
    ("teams", "teams.jsonl", TEAMS_QUERY, ["teams"]),
    ("users", "users.jsonl", USERS_QUERY, ["users"]),
    ("workflow_states", "workflow_states.jsonl", WORKFLOW_STATES_QUERY, ["workflowStates"]),
    ("labels", "labels.jsonl", LABELS_QUERY, ["issueLabels"]),
    ("cycles", "cycles.jsonl", CYCLES_QUERY, ["cycles"]),
    ("initiatives", "initiatives.jsonl", INITIATIVES_QUERY, ["initiatives"]),
    ("projects", "projects.jsonl", PROJECTS_QUERY, ["projects"]),
    ("project_milestones", "project_milestones.jsonl", PROJECT_MILESTONES_QUERY, ["projectMilestones"]),
    ("issues", "issues.jsonl", ISSUES_QUERY, ["issues"]),
    ("comments", "comments.jsonl", COMMENTS_QUERY, ["comments"]),
    ("attachments", "attachments.jsonl", ATTACHMENTS_QUERY, ["attachments"]),
    ("project_updates", "project_updates.jsonl", PROJECT_UPDATES_QUERY, ["projectUpdates"]),
    ("initiative_updates", "initiative_updates.jsonl", INITIATIVE_UPDATES_QUERY, ["initiativeUpdates"]),
]


VIEWER_QUERY = """
query Viewer {
  viewer { id name email }
  organization { id name urlKey }
}
"""
