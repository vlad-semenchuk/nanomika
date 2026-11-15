## Approvals module

Admin-gated approval flow. Lives in `src/modules/approvals/`.

### Flow

A caller invokes `requestApproval()` with an `action` string and a payload. The module picks an approver (owner, global admin, or scoped admin), delivers an approval card to that approver's DM, and persists a `pending_approvals` row. When the admin clicks a button, the response handler claims the row and dispatches to the handler registered for that `action` via `registerApprovalHandler()`. The handler applies the change and notifies the requesting agent.

Current client: `src/cli/dispatch.ts` registers `cli_command`, so `ncl` commands marked `access: 'approval'` wait for an admin before they run.

### Wiring

- **Response handler:** registered with `registerResponseHandler` at import time.
- **Public API:** `requestApproval`, `registerApprovalHandler`, `notifyAgent` (re-exported from `primitive.ts`).

### Tables

`pending_approvals` (created by `module-approvals-pending-approvals.ts`).

### Core integration

- `pickApprover`, `pickApprovalDelivery` live in `primitive.ts`.
- The delivery adapter is read through `getDeliveryAdapter`.

Removing the module: delete `src/modules/approvals/` and its import in `src/modules/index.ts`, and remove the approval gate from `src/cli/dispatch.ts`. Button clicks on approval cards will then log "Unclaimed response".
