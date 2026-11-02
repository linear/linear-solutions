// Role policy for approving a protected-issue reorder. Pure: no I/O.
//
// Allowed: active, non-app users in the same organization as the guardrail's API key
// who are workspace owners, workspace admins, or owners (team admins) of exactly the
// configured TEST team through an active membership.
// Denied: everything else, including webhook actors that are not `user` (integration,
// oauthClient, externalUser, missing), unknown users, and the API key's own user.
//
// Caveat: on the Free plan Linear reports every member as admin, so every active member
// would be allowed. See README "Role-aware approvals".
export const ACTOR_TYPES = ['user', 'integration', 'oauthClient', 'externalUser'];

const allow = reason => ({ allowed: true, reason });
const deny = reason => ({ allowed: false, reason });

export function actorType(actor) {
  if (!actor) return 'none';
  return ACTOR_TYPES.includes(actor.type) ? actor.type : 'unknown';
}

export function authorize({ actor, user, viewer, team }) {
  const type = actorType(actor);
  if (type !== 'user') return deny(`actor-type-${type}`);
  if (!user || typeof actor.id !== 'string' || user.id !== actor.id) return deny('unknown-user');
  // A user-type actor cannot distinguish UI drags from API calls made with that user's key.
  // The guardrail's own key user therefore never approves, even when it is an admin.
  if (viewer?.id && user.id === viewer.id) return deny('guardrail-api-key-user');
  const org = viewer?.organization?.id;
  if (!org || user.organization?.id !== org) return deny('other-organization');
  if (user.active !== true) return deny('inactive-user');
  if (user.app !== false) return deny('app-user');
  if (user.owner === true) return allow('workspace-owner');
  if (user.admin === true) return allow('workspace-admin');
  const memberships = Array.isArray(user.teamMemberships) ? user.teamMemberships : [];
  if (memberships.some(m => m?.owner === true && !m.archivedAt && m.team?.id === team)) return allow('team-owner');
  if (user.membershipsComplete === false) return deny('membership-lookup-incomplete');
  return deny('not-owner-admin-or-team-owner');
}
