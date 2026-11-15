import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_DIR = '/tmp/nanomika-test-bootstrap';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanomika-test-bootstrap/data',
    GROUPS_DIR: '/tmp/nanomika-test-bootstrap/groups',
  };
});

import { bootstrapFirstAgent } from './bootstrap.js';
import { closeDb, createAgentGroup, getAllAgentGroups, getDb, initTestDb, runMigrations } from './db/index.js';
import { getMessagingGroupAgents, getMessagingGroupByPlatform } from './db/messaging-groups.js';
import { getOwners } from './modules/permissions/db/user-roles.js';
import { getUser } from './modules/permissions/db/users.js';

function count(table: string): number {
  return (getDb().prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

describe('bootstrapFirstAgent', () => {
  beforeEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    runMigrations(initTestDb());
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('creates the CLI owner, agent group, folder, messaging group and wiring on an empty DB', () => {
    expect(bootstrapFirstAgent('Andy')).toBe(true);

    const groups = getAllAgentGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('Andy');
    expect(groups[0].folder).toBe('main');

    expect(getUser('cli:local')?.kind).toBe('cli');
    const owners = getOwners();
    expect(owners).toHaveLength(1);
    expect(owners[0].user_id).toBe('cli:local');
    expect(owners[0].agent_group_id).toBeNull();

    const mg = getMessagingGroupByPlatform('cli', 'local');
    expect(mg).toBeDefined();
    expect(mg!.unknown_sender_policy).toBe('public');

    const wirings = getMessagingGroupAgents(mg!.id);
    expect(wirings).toHaveLength(1);
    expect(wirings[0].agent_group_id).toBe(groups[0].id);
    expect(wirings[0].engage_mode).toBe('pattern');
    expect(wirings[0].engage_pattern).toBe('.');
    expect(wirings[0].session_mode).toBe('shared');

    expect(count('agent_destinations')).toBe(1);
    expect(count('container_configs')).toBe(1);

    const local = fs.readFileSync(path.join(TEST_DIR, 'groups', 'main', 'CLAUDE.local.md'), 'utf-8');
    expect(local).toContain('You are Andy');
  });

  it('is idempotent: a second call changes nothing', () => {
    bootstrapFirstAgent('Andy');
    const before = ['users', 'user_roles', 'agent_groups', 'messaging_groups', 'messaging_group_agents'].map(count);

    expect(bootstrapFirstAgent('Andy')).toBe(false);

    const after = ['users', 'user_roles', 'agent_groups', 'messaging_groups', 'messaging_group_agents'].map(count);
    expect(after).toEqual(before);
  });

  it('does nothing when any agent group already exists', () => {
    createAgentGroup({
      id: 'ag-existing',
      name: 'Existing',
      folder: 'existing',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });

    expect(bootstrapFirstAgent('Andy')).toBe(false);

    expect(getAllAgentGroups()).toHaveLength(1);
    expect(count('users')).toBe(0);
    expect(count('user_roles')).toBe(0);
    expect(count('messaging_groups')).toBe(0);
    expect(fs.existsSync(path.join(TEST_DIR, 'groups', 'main'))).toBe(false);
  });
});
