import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../container-runner.js', () => ({ wakeContainer: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../config.js', async () => {
  const actual = await vi.importActual('../../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanomika-test-approval-response' };
});

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../../db/index.js';
import { createPendingApproval, createSession, getPendingApproval } from '../../../db/sessions.js';
import { initSessionFolder } from '../../../session-manager.js';
import { grantRole } from '../../../modules/permissions/db/user-roles.js';
import { createUser } from '../../../modules/permissions/db/users.js';
import { registerApprovalHandler } from '../../../modules/approvals/primitive.js';
import { handleApprovalsResponse } from '../../../modules/approvals/response-handler.js';

const TEST_DIR = '/tmp/nanomika-test-approval-response';
const applied = vi.fn();
registerApprovalHandler('test_action', async () => applied());

function now(): string {
  return new Date().toISOString();
}

describe('approval answers', () => {
  beforeEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    runMigrations(initTestDb());
    createAgentGroup({ id: 'ag-1', name: 'A', folder: 'a', agent_provider: null, created_at: now() });
    createSession({
      id: 'sess-1',
      agent_group_id: 'ag-1',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now(),
    });
    initSessionFolder('ag-1', 'sess-1');
    for (const id of ['cli:local', 'slack:member']) {
      createUser({ id, kind: id.split(':')[0], display_name: null, created_at: now() });
    }
    grantRole({ user_id: 'cli:local', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
    createPendingApproval({
      approval_id: 'appr-1',
      session_id: 'sess-1',
      request_id: 'r1',
      action: 'test_action',
      payload: '{}',
      created_at: now(),
      title: 't',
      options_json: '[]',
    });
    applied.mockClear();
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  const answer = (userId: string | null, channelType: string) =>
    handleApprovalsResponse({
      questionId: 'appr-1',
      value: 'approve',
      userId,
      channelType,
      platformId: 'p',
      threadId: null,
    });

  it('ignores an answer from someone who is not an owner or admin', async () => {
    expect(await answer('member', 'slack')).toBe(true);
    expect(await answer(null, 'slack')).toBe(true);
    expect(applied).not.toHaveBeenCalled();
    expect(getPendingApproval('appr-1')).toBeDefined();
  });

  it('applies an answer from the owner', async () => {
    expect(await answer('cli:local', 'cli')).toBe(true);
    expect(applied).toHaveBeenCalledOnce();
    expect(getPendingApproval('appr-1')).toBeUndefined();
  });
});
