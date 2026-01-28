# Session Switcher and New Session Button

## Status: ✅ COMPLETED

## Goal

Implement session switcher and new session button at the top of the extension, similar to Amp's design:
- Session switcher button that shows current session title and opens a dropdown of all sessions
- New session button to the right of the switcher
- Top bar containing both buttons, separated from the message pane with a divider

## Research Findings

### OpenCode SDK Session Support

✅ **Session Management Available**

The OpenCode SDK provides comprehensive session management:

1. **Session Type** (from `@opencode-ai/sdk`)
   ```typescript
   export type Session = {
     id: string;
     projectID: string;
     directory: string;
     parentID?: string;
     title: string;  // ✅ Session titles ARE supported!
     version: string;
     time: {
       created: number;
       updated: number;
       compacting?: number;
     };
     summary?: { diffs: Array<FileDiff> };
     share?: { url: string };
     revert?: { ... };
   }
   ```

2. **Session API Methods**
   - `client.session.list()` - Returns `Array<Session>` (all sessions for current directory)
   - `client.session.create({ body: { title?, parentID? } })` - Create new session with optional title
   - `client.session.get({ path: { id } })` - Get single session by ID
   - `client.session.update({ path: { id }, body: { title } })` - Update session title
   - `client.session.delete({ path: { id } })` - Delete session

3. **Current Implementation**
   - `OpenCodeService.createSession(title?)` already exists and supports titles
   - Currently creates sessions with default title "VSCode Session"
   - Only tracks `currentSessionId` but doesn't fetch/display available sessions

## Design Spec

### UI Layout

```
┌─────────────────────────────────────────────┐
│ [Session Title ▼]  [+]                      │ ← Top bar
├─────────────────────────────────────────────┤ ← Divider
│                                             │
│ Message 1                                   │
│ Message 2                                   │
│ ...                                         │
│                                             │
│ ┌─────────────────────────────────────────┐ │
│ │ [Agent ▼]  [⌘⏎]                         │ │
│ │ [Prompt input...]                       │ │
│ └─────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

### Session Switcher Button

- **Position**: Top-left of extension view
- **Style**: Similar to agent switcher - button that opens dropdown
- **Label**: Shows current session title (truncated if long)
- **Dropdown Icon**: Down arrow (▼) to indicate expandability
- **Behavior**:
  - Click opens dropdown below button
  - Dropdown shows list of all sessions with titles
  - Each session item shows title and creation time
  - Click on session item switches to that session
  - Current session is highlighted
- **Empty State**: If no session yet, show "New Session" or similar

### New Session Button

- **Position**: To the right of session switcher (small gap between them)
- **Style**: Quiet style (minimal, secondary appearance)
- **Icon/Text**: `+` symbol
- **Behavior**: 
  - Click creates new session with default title
  - Switches to the new session immediately
  - New session gets auto-generated title like "Session [timestamp]" or "Untitled Session"

### Top Bar

- **Container**: `.top-bar` div wrapping both buttons
- **Styling**: 
  - Horizontal flexbox layout
  - Padding: 8px (matches input container)
  - Background: `--vscode-sideBar-background`
  - Border-bottom: 1px solid `--vscode-panel-border` (divider)
  - Gap between buttons: 8px

### Dropdown Styling

- **Container**: Positioned absolutely below session switcher button
- **Items**: Each session shows:
  - Title (bold)
  - Relative time (e.g., "2 hours ago")
- **Selected Item**: Different background color
- **Hover State**: Highlight on hover
- **Max Height**: Scrollable if many sessions (e.g., max 300px with overflow-y)

## Implementation Plan

### 1. Backend Changes (OpenCodeService.ts)

Add methods:
```typescript
async listSessions(): Promise<Session[]>
async switchSession(sessionId: string): void
async createNewSession(title?: string): Promise<string>
getCurrentSessionId(): string | null
getCurrentSessionTitle(): string
```

### 2. Message Protocol Updates

Add new message types for webview ↔ extension communication:

Host → Webview:
```typescript
{ type: 'session-list', sessions: Session[] }
{ type: 'session-switched', sessionId: string, title: string }
```

Webview → Host:
```typescript
{ type: 'load-sessions' }
{ type: 'switch-session', sessionId: string }
{ type: 'create-session', title?: string }
```

### 3. UI Components (SolidJS)

Create components:
- `src/webview/components/TopBar.tsx` - Container for session switcher + new button
- `src/webview/components/SessionSwitcher.tsx` - Dropdown button showing current session
- `src/webview/components/NewSessionButton.tsx` - Simple + button

Update `App.tsx`:
- Add session state: `createSignal<Session[]>([])`, `createSignal<string | null>(null)`
- Add message handlers for session-related messages
- Render TopBar at top of view (before MessageList)

### 4. State Management

- Track `sessions` (list of all sessions)
- Track `currentSessionId` (ID of active session)
- When session switches:
  - Clear messages array
  - Update currentSessionId
  - Request fresh message history for new session (if needed)

### 5. Styling (App.css)

```css
.top-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  background: var(--vscode-sideBar-background);
  border-bottom: 1px solid var(--vscode-panel-border);
}

.session-switcher {
  /* Button style similar to agent switcher */
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  /* ... */
}

.session-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  max-height: 300px;
  overflow-y: auto;
  background: var(--vscode-dropdown-background);
  border: 1px solid var(--vscode-dropdown-border);
  /* ... */
}

.new-session-button {
  /* Quiet style - minimal */
  padding: 4px 8px;
  /* ... */
}
```

## Edge Cases & Considerations

1. **No sessions yet**: Show placeholder in switcher, disable dropdown
2. **Session creation failure**: Show error message, don't switch
3. **Session switch during active prompt**: Should we allow? Or disable during thinking?
4. **Deleted session**: Handle 404 errors, remove from list
5. **Session titles**: 
   - Max length for display (truncate with ellipsis)
   - Default title generation strategy
   - Allow inline editing? (future enhancement)
6. **Performance**: Refresh session list periodically or on focus? Or only on demand?
7. **Message history**: When switching sessions, do we load historical messages? OpenCode SDK might not support this easily

## Testing Plan

1. Create multiple sessions and verify they appear in dropdown
2. Switch between sessions and verify UI updates
3. Create new session and verify it's added to list and switched to
4. Verify session titles display correctly
5. Test with long session titles (truncation)
6. Test with no sessions (empty state)
7. Verify divider styling matches design
8. Test keyboard navigation in dropdown (if applicable)

## Future Enhancements

- Inline title editing in dropdown
- Delete session from dropdown (trash icon)
- Search/filter sessions if many exist
- Session grouping by project
- Persist current session across extension reloads
- Show message count or last activity time in dropdown
- Export/import sessions

## Implementation Summary

### What Was Implemented

1. **Backend (OpenCodeService.ts)**
   - `listSessions()` - Fetches all sessions from OpenCode API
   - `switchSession(sessionId)` - Switches to a different session and updates state
   - `createNewSession(title?)` - Creates new session with auto-generated or custom title
   - `getCurrentSessionId()` - Returns current session ID
   - `getCurrentSessionTitle()` - Returns current session title
   - Added `currentSessionTitle` state tracking

2. **Message Protocol (types.ts)**
   - Added `Session` interface with id, title, projectID, directory, and timestamps
   - Extended `HostMessage` type with `session-list` and `session-switched` messages
   - Extended `WebviewMessage` type with `load-sessions`, `switch-session`, and `create-session` messages

3. **View Provider (OpenCodeViewProvider.ts)**
   - `_handleLoadSessions()` - Loads and sends session list to webview
   - `_handleSwitchSession(sessionId)` - Switches session and notifies webview
   - `_handleCreateSession(title?)` - Creates new session and updates webview
   - All handlers properly integrated with message routing

4. **UI Components (SolidJS)**
   - **TopBar.tsx** - Container component that orchestrates session switcher and new button
   - **SessionSwitcher.tsx** - Dropdown button showing current session with list of all sessions
   - **NewSessionButton.tsx** - Simple + button to create new sessions
   - Components use SolidJS signals and primitives for reactive state

5. **App Integration (App.tsx)**
   - Added session state management: `sessions`, `currentSessionId`, `currentSessionTitle`
   - Integrated session handlers in `useVsCodeBridge`: `onSessionList`, `onSessionSwitched`
   - Added `onMount` hook to load sessions on startup
   - Added `handleSessionSelect` and `handleNewSession` handlers
   - TopBar rendered at top of view, above messages and input

6. **VSCode Bridge (useVsCodeBridge.ts)**
   - Extended `VsCodeBridgeCallbacks` interface with session callbacks
   - Added message handlers for `session-list` and `session-switched` events
   - Properly typed with `Session` interface

7. **Styling (App.css)**
   - `.top-bar` - Flexbox container with border-bottom divider
   - `.session-switcher` and `.session-switcher-button` - Full-width button with title and dropdown arrow
   - `.session-dropdown` - Absolutely positioned dropdown with scrolling
   - `.session-item` - Individual session items with hover and selected states
   - `.new-session-button` - Quiet style button matching agent switcher
   - All styles use VSCode theme variables for consistency

### How It Works

1. On extension load, webview sends `load-sessions` message
2. Extension calls `listSessions()` and sends back `session-list` message
3. User clicks session switcher button, dropdown opens showing all sessions
4. User clicks a session item, webview sends `switch-session` message
5. Extension switches to that session, clears messages, sends `session-switched` message
6. Webview updates UI and clears message list
7. User clicks "+" button, webview sends `create-session` message
8. Extension creates new session with timestamp title, switches to it, reloads session list

### Files Modified

- `src/OpenCodeService.ts` - Added session management methods
- `src/OpenCodeViewProvider.ts` - Added session message handlers
- `src/webview/types.ts` - Added Session interface and message types
- `src/webview/hooks/useVsCodeBridge.ts` - Added session callbacks
- `src/webview/App.tsx` - Integrated TopBar and session state
- `src/webview/App.css` - Added session UI styles

### Files Created

- `src/webview/components/TopBar.tsx` - Top bar container
- `src/webview/components/SessionSwitcher.tsx` - Session dropdown
- `src/webview/components/NewSessionButton.tsx` - New session button
- `docs/todos/session-switcher.md` - This spec document

### Build Status

✅ Extension builds successfully (no errors)
✅ Webview builds successfully (no errors)
✅ All TypeScript types properly defined
✅ CSS styling complete and consistent

### Known Limitations

1. **No message history loading** - When switching sessions, messages are cleared but historical messages from the session are not loaded. OpenCode SDK doesn't provide easy access to past messages.
2. **Session titles not editable** - Users can't rename sessions after creation
3. **No session deletion** - Can't delete old sessions from the UI
4. **No session persistence** - Current session selection doesn't persist across extension reloads
5. **Dropdown doesn't close on outside click** - Currently only closes when selecting a session

### Testing Recommendations

1. Test creating multiple sessions
2. Test switching between sessions
3. Test session titles display correctly
4. Test dropdown styling in light and dark themes
5. Test with many sessions (scrolling behavior)
6. Test session creation with different title lengths
7. Verify messages clear when switching sessions
