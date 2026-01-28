# Session State Sync Fix

## Problem

When the OpenCode VSCode extension webview is reopened (after being closed/hidden), the UI shows "New Session" but the backend maintains an existing active session. When the user sends a prompt, it gets added to the old session instead of creating a new one, causing confusion.

## Root Cause

The issue was a state synchronization problem between the webview (UI) and the extension backend:

1. **Backend state persists**: `OpenCodeService` maintains `currentSessionId` and `currentSessionTitle` as instance variables that survive when the webview is hidden/closed.

2. **Webview state resets**: When the webview reopens, it reinitializes with default values (`currentSessionTitle = "New Session"`, `currentSessionId = null`).

3. **No state restoration**: The initialization flow (`onMount` → "ready" → "init") did not include the active session state, so the webview had no way to know about the backend's active session.

4. **Divergent behavior**: When sending a prompt, the backend would use the existing `currentSessionId` (line 146 in OpenCodeViewProvider.ts) while the UI thought it was starting a new session.

## Solution

Extended the initialization protocol to include session state restoration:

### 1. Updated Type Definitions (`src/webview/types.ts`)

Added session state fields to the `init` message type:
- `currentSessionId?: string | null`
- `currentSessionTitle?: string`  
- `currentSessionMessages?: IncomingMessage[]`

### 2. Backend Changes (`src/OpenCodeViewProvider.ts`)

Created a new `_handleReady()` method that:
- Retrieves current session ID and title from `OpenCodeService`
- If there's an active session, loads its messages
- Sends all this data in the `init` message to the webview

### 3. Frontend Changes (`src/webview/hooks/useVsCodeBridge.ts` & `src/webview/App.tsx`)

Updated the `onInit` callback to:
- Accept the new session state parameters
- Restore `currentSessionId` and `currentSessionTitle` if they exist
- Parse and load the session messages into the UI

## Files Modified

1. `src/webview/types.ts` - Added session state to `HostMessage` init type
2. `src/OpenCodeViewProvider.ts` - Added `_handleReady()` method to send session state on init
3. `src/webview/hooks/useVsCodeBridge.ts` - Updated callback signature to receive session state
4. `src/webview/App.tsx` - Restored session state in `onInit` handler

## Flow After Fix

When the webview reopens:

1. ✅ Webview mounts and sends "ready"
2. ✅ Backend sends "init" with ready status, workspace root, **current session ID, title, and messages**
3. ✅ Webview restores session state (ID, title, messages) from init message
4. ✅ UI displays the correct session title and message history
5. ✅ When user sends a prompt, UI and backend are in sync about which session to use

## Testing

To verify the fix:

1. Open OpenCode extension
2. Send a message to create a session
3. Close/hide the sidebar
4. Reopen the sidebar
5. **Expected**: UI shows the previous session title and messages
6. Send another message
7. **Expected**: Message is added to the same session (visible in session history)

## Prevention

To prevent similar issues in the future:

- Always consider webview lifecycle when designing state management
- Document which state persists in the backend and which resets in the webview
- Include comprehensive state restoration in initialization protocols
- Add integration tests for webview hide/show scenarios
