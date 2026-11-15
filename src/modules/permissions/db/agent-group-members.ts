import type { AgentGroupMember } from '../../../types.js';
import { getDb } from '../../../db/connection.js';
import { isAdminOfAgentGroup, isGlobalAdmin, isOwner } from './user-roles.js';

export function addMember(row: AgentGroupMember): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO agent_group_members (user_id, agent_group_id, added_by, added_at)
       VALUES (@user_id, @agent_group_id, @added_by, @added_at)`,
    )
    .run(row);
}

/**
 * Is the user "known" in this agent group?
 * Owner, global admin, and scoped admin are implicitly members.
 */
export function isMember(userId: string, agentGroupId: string): boolean {
  if (isOwner(userId) || isGlobalAdmin(userId) || isAdminOfAgentGroup(userId, agentGroupId)) {
    return true;
  }
  const row = getDb()
    .prepare('SELECT 1 FROM agent_group_members WHERE user_id = ? AND agent_group_id = ? LIMIT 1')
    .get(userId, agentGroupId);
  return !!row;
}
