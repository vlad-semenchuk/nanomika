/**
 * Modules barrel.
 *
 * Each module self-registers at import time. This barrel is imported by
 * src/index.ts for side effects (registry registrations, typing impl setup,
 * etc.). The registries have inline fallbacks and `sqlite_master` guards, so
 * core still runs if a module import is removed.
 *
 * Imported directly by core instead of through this barrel:
 *   - src/modules/typing/        → router/delivery/container-runner
 *   - src/modules/mount-security/ → container-runner
 *
 * To add a module: create `src/modules/<name>/index.ts` and append its import
 * below. Approvals loads first so `registerApprovalHandler` / `requestApproval`
 * are bound before any module that registers approval handlers.
 */
import './approvals/index.js';
import './interactive/index.js';
import './scheduling/index.js';
import './permissions/index.js';
import './agent-to-agent/index.js';
