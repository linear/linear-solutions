import { config } from "./config.js";
import type { AdoEventType, AdoPullRequestResource, LinkKind } from "./types.js";

// ---------------------------------------------------------------------------
// Automation states (mirrors GitAutomationStates from linear-app)
// ---------------------------------------------------------------------------

export enum AutomationState {
  Draft = "draft",
  Start = "start",
  Review = "review",
  Mergeable = "mergeable",
  Merge = "merge",
  Cancelled = "cancelled",
}

/**
 * Ordered progression of states for preventing backward transitions.
 * Higher index = further along in the workflow.
 */
const STATE_ORDER: AutomationState[] = [
  AutomationState.Draft,
  AutomationState.Start,
  AutomationState.Review,
  AutomationState.Mergeable,
  AutomationState.Merge,
];

// ---------------------------------------------------------------------------
// State mapping: automation state -> Linear workflow state name
// ---------------------------------------------------------------------------

function mapToLinearStateName(state: AutomationState): string | null {
  switch (state) {
    case AutomationState.Draft:
    case AutomationState.Start:
      return config.stateMapping.started;
    case AutomationState.Review:
      return config.stateMapping.inReview;
    case AutomationState.Mergeable:
      // If no separate "Ready to Merge" state configured, stays in review
      return config.stateMapping.inReview;
    case AutomationState.Merge:
      return config.stateMapping.done;
    case AutomationState.Cancelled:
      return config.stateMapping.cancelled;
  }
}

// ---------------------------------------------------------------------------
// Determine target automation state from ADO event
// ---------------------------------------------------------------------------

export interface AutomationResult {
  targetState: AutomationState;
  linearStateName: string | null;
  shouldTransition: boolean;
}

/**
 * Determine what automation state a PR event should transition to.
 * Mirrors GitRequestAutomation from the Linear GitHub integration.
 */
export function determineTargetState(
  eventType: AdoEventType,
  resource: AdoPullRequestResource,
  linkKind: LinkKind
): AutomationResult {
  let targetState: AutomationState;

  // Abandoned PRs -> Cancelled
  if (resource.status === "abandoned") {
    targetState = AutomationState.Cancelled;
    return {
      targetState,
      linearStateName: mapToLinearStateName(targetState),
      shouldTransition: linkKind !== "links",
    };
  }

  // Completed PRs — only when status is actually "completed", not on merge
  // attempt events (git.pullrequest.merged fires on attempt, not completion,
  // and often arrives with status "active").
  if (resource.status === "completed") {
    if (resource.mergeStatus === "succeeded") {
      if (linkKind === "closes") {
        targetState = AutomationState.Merge;
      } else {
        // contributes/links: don't transition to Done
        return {
          targetState: AutomationState.Merge,
          linearStateName: null,
          shouldTransition: false,
        };
      }
    } else {
      // Merge failed — stay where we are
      return {
        targetState: AutomationState.Review,
        linearStateName: null,
        shouldTransition: false,
      };
    }

    return {
      targetState,
      linearStateName: mapToLinearStateName(targetState),
      shouldTransition: true,
    };
  }

  // PR created
  if (eventType === "git.pullrequest.created") {
    targetState = resource.isDraft ? AutomationState.Draft : AutomationState.Start;
    return {
      targetState,
      linearStateName: mapToLinearStateName(targetState),
      shouldTransition: linkKind !== "links",
    };
  }

  // PR updated — determine sub-event
  if (eventType === "git.pullrequest.updated") {
    // Draft status
    if (resource.isDraft) {
      targetState = AutomationState.Draft;
      return {
        targetState,
        linearStateName: mapToLinearStateName(targetState),
        shouldTransition: linkKind !== "links",
      };
    }

    // Check reviewer votes
    const reviewers = resource.reviewers.filter((r) => !r.isContainer);
    const hasReviewers = reviewers.length > 0;
    const allApproved =
      hasReviewers && reviewers.every((r) => r.vote >= 5);
    const anyApproved = reviewers.some((r) => r.vote >= 5);

    if (allApproved) {
      targetState = AutomationState.Mergeable;
    } else if (hasReviewers) {
      targetState = AutomationState.Review;
    } else {
      targetState = AutomationState.Start;
    }

    // If coming back from abandoned to active
    if (resource.status === "active" && !hasReviewers) {
      targetState = AutomationState.Start;
    }

    return {
      targetState,
      linearStateName: mapToLinearStateName(targetState),
      shouldTransition: linkKind !== "links",
    };
  }

  // Comment events don't trigger state transitions
  return {
    targetState: AutomationState.Start,
    linearStateName: null,
    shouldTransition: false,
  };
}

/**
 * Check if a transition should proceed based on current vs target state.
 * Prevents backward transitions (e.g., "In Review" -> "In Progress" on a push).
 */
export function shouldAllowTransition(
  currentStateName: string | undefined,
  targetAutomationState: AutomationState
): boolean {
  if (!currentStateName) return true;

  // Cancelled is always allowed (can go from any state to cancelled)
  if (targetAutomationState === AutomationState.Cancelled) return true;

  // Merge (Done) is always allowed for closing links
  if (targetAutomationState === AutomationState.Merge) return true;

  // Map current Linear state name back to approximate automation state
  const currentAutomation = resolveCurrentAutomationState(currentStateName);
  if (!currentAutomation) return true;

  const currentIndex = STATE_ORDER.indexOf(currentAutomation);
  const targetIndex = STATE_ORDER.indexOf(targetAutomationState);

  // Allow forward or same-level transitions only
  return targetIndex >= currentIndex;
}

function resolveCurrentAutomationState(stateName: string): AutomationState | null {
  const { stateMapping } = config;
  if (stateName === stateMapping.done) return AutomationState.Merge;
  if (stateName === stateMapping.cancelled) return AutomationState.Cancelled;
  if (stateName === stateMapping.inReview) return AutomationState.Review;
  if (stateName === stateMapping.started) return AutomationState.Start;
  return null;
}
