/**
 * First-start bootstrap.
 *
 * On a fresh clone the central DB is empty, so there is nothing to talk to.
 * When no agent group exists yet, this creates the minimum needed for
 * `pnpm run chat` to work:
 *
 *   - the `cli:local` user, granted the global owner role if no owner exists
 *   - one agent group (name from ASSISTANT_NAME, folder `main`) and its
 *     group folder with starting instructions in CLAUDE.local.md
 *   - the `cli/local` messaging group
 *   - the wiring between them (every message engages, one shared session)
 *
 * Idempotent: does nothing when any agent group already exists. Add more
 * agents and channels afterwards with `ncl`.
 */
import { ASSISTANT_NAME } from './config.js';
import { createAgentGroup, getAgentGroupByFolder, getAllAgentGroups } from './db/agent-groups.js';
import { getDb } from './db/connection.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from './db/messaging-groups.js';
import { initGroupFilesystem } from './group-init.js';
import { log } from './log.js';
import { grantRole, hasAnyOwner } from './modules/permissions/db/user-roles.js';
import { upsertUser } from './modules/permissions/db/users.js';
import type { MessagingGroup } from './types.js';

const CLI_CHANNEL = 'cli';
const CLI_PLATFORM_ID = 'local';
const CLI_USER_ID = `${CLI_CHANNEL}:${CLI_PLATFORM_ID}`;
const DEFAULT_FOLDER = 'main';

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function starterInstructions(name: string): string {
  return (
    `# ${name}\n\n` +
    `You are ${name}, a personal NanoMika agent. ` +
    'When the user first reaches out, introduce yourself briefly and invite them to chat. Keep replies concise.'
  );
}

/**
 * Create the first agent and wire it to the local CLI channel if the DB has
 * no agent groups. Returns true when it created something.
 */
export function bootstrapFirstAgent(agentName: string = ASSISTANT_NAME): boolean {
  if (getAllAgentGroups().length > 0) return false;
  // One transaction: if creating the group folder fails, no half-made agent
  // is left behind to stop the next start from finishing the setup.
  return getDb().transaction(() => createFirstAgent(agentName))();
}

function createFirstAgent(agentName: string): boolean {
  const now = new Date().toISOString();

  upsertUser({ id: CLI_USER_ID, kind: CLI_CHANNEL, display_name: 'Local user', created_at: now });
  if (!hasAnyOwner()) {
    grantRole({ user_id: CLI_USER_ID, role: 'owner', agent_group_id: null, granted_by: null, granted_at: now });
  }

  createAgentGroup({
    id: generateId('ag'),
    name: agentName,
    folder: DEFAULT_FOLDER,
    agent_provider: null,
    created_at: now,
  });
  const ag = getAgentGroupByFolder(DEFAULT_FOLDER)!;
  initGroupFilesystem(ag, { instructions: starterInstructions(agentName) });

  let mg: MessagingGroup | undefined = getMessagingGroupByPlatform(CLI_CHANNEL, CLI_PLATFORM_ID);
  if (!mg) {
    mg = {
      id: generateId('mg'),
      channel_type: CLI_CHANNEL,
      platform_id: CLI_PLATFORM_ID,
      name: 'Local CLI',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now,
    };
    createMessagingGroup(mg);
  }

  if (!getMessagingGroupAgentByPair(mg.id, ag.id)) {
    createMessagingGroupAgent({
      id: generateId('mga'),
      messaging_group_id: mg.id,
      agent_group_id: ag.id,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now,
    });
  }

  log.info('First start: created agent and wired it to the local CLI', {
    agent: agentName,
    agentGroupId: ag.id,
    folder: `groups/${DEFAULT_FOLDER}`,
    owner: CLI_USER_ID,
  });
  return true;
}
