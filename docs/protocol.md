# Codex JSON-RPC Protocol Contract

## Handshake

### 1. Initialize
- Method: `initialize`
- ID: `0`
- Params:
  ```json
  {
    "clientInfo": {
      "name": "wimu",
      "title": "WIMU",
      "version": "0.5.3"
    }
  }
  ```
- Expected Result: JSON object containing server capabilities.
- Error Handling:
  - `-32601` (Method not found) or `-32602` (Invalid params) marks the CLI as incompatible.
  - Other errors are considered transient and retried with backoff.

### 2. Initialized Notification
- Method: `initialized`
- Params: `{}`

## Rate Limits Retrieval

### 1. Request Limits
- Method: `account/rateLimits/read`
- ID: Sequential incrementing integer (`next_id >= 1`)
- Coalescing: At most one read request is in-flight at any time. Further read requests while one is pending do not overwrite the pending request ID.

### 2. Response Shape
- Result contains either `rateLimitsByLimitId` or `rateLimits`.
- Windows are identified by duration:
  - `300` minutes: 5-hour window.
  - `10080` minutes: weekly window.
- In `rateLimitsByLimitId`, the `codex` bucket takes precedence over other limit IDs for duplicate durations.

### 3. Rate Limits Notification
- Method: `account/rateLimits/updated`
- Params: Contains updated window definitions.
- If the notification provides only a partial window, a coalesced full read (`account/rateLimits/read`) is scheduled.

## Error Taxonomy
- Incompatible: Codes `-32601`, `-32602`, and `-32600` without authentication messages.
- Needs Login: HTTP 401, 403, or messages containing "authentication required" or "unauthorized".
- Transient: Codes `-32603`, `-32000..=-32099`, or unexpected server disconnections (retried with exponential backoff).
