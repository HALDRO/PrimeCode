# Agent Switcher Feature

## Goal

Add an agent switcher UI component that allows users to toggle between different OpenCode agents configured in their workspace.

## Research Findings

### OpenCode API Agent Support

1. **Agent List API**: `app.agents()` returns `Array<Agent>` where `Agent` has:
   - `name: string` - agent identifier
   - `description?: string` - description of when to use the agent
   - `mode: "subagent" | "primary" | "all"` - determines if agent can be used as primary
   - `builtIn: boolean` - whether it's a built-in agent
   - `model?: { modelID, providerID }` - optional model override
   - `prompt?: string` - custom system prompt
   - `temperature, topP` - optional model parameters
   - `tools, permission, options` - configuration

2. **Session Prompt API**: `session.prompt()` accepts an `agent?: string` parameter in the body to specify which agent to use for that prompt.

3. **Config Structure**: Agents are defined in `opencode.json` under the `agents` key:
   ```json
   {
     "agents": {
       "general": { "description": "General purpose", "mode": "primary" },
       "build": { "description": "Build focused", "mode": "primary" },
       "plan": { "description": "Planning", "mode": "primary" }
     }
   }
   ```

### Current UI Implementation

1. **Prompt Editor**: Located in `App.tsx` lines 327-351, rendered via `renderInput()` function
2. **Layout**: Currently uses absolute positioning for the submit button (`shortcut-button`)
3. **Styling**: Uses VSCode theme variables, blue focus outline, quiet button style
4. **Structure**:
   - `.input-container` - form wrapper with padding/border
   - `.textarea-wrapper` - relative positioned container
   - `.prompt-input` - textarea with auto-resize (36-120px)
   - `.shortcut-button` - ⌘⏎ button absolutely positioned bottom-right

## Implementation Spec

### 1. Backend Changes (OpenCodeService.ts)

#### Add Agent Management

```typescript
// New property to track available agents
private agents: Agent[] = [];
private selectedAgent: string | null = null;

// New method to fetch agents
async getAgents(): Promise<Agent[]> {
  if (!this.opencode) {
    throw new Error('OpenCode not initialized');
  }

  const result = await this.opencode.client.app.agents();
  
  if (result.error) {
    throw new Error(`Failed to get agents: ${JSON.stringify(result.error)}`);
  }

  // Filter to only "primary" or "all" mode agents (not "subagent" only)
  this.agents = (result.data || []).filter(
    (agent) => agent.mode === 'primary' || agent.mode === 'all'
  );
  
  return this.agents;
}

// Update prompt methods to include agent parameter
async sendPrompt(text: string, sessionId?: string, agent?: string): Promise<...>
async sendPromptStreaming(
  text: string, 
  onEvent: (event: Event) => void, 
  sessionId?: string,
  agent?: string
): Promise<void>
```

#### Update Prompt Sending

Modify both `sendPrompt` and `sendPromptStreaming` to include the agent parameter:

```typescript
const result = await this.opencode.client.session.prompt({
  path: { id: sid },
  body: {
    model: { providerID, modelID },
    parts: [{ type: 'text', text }],
    agent: agent || undefined, // Add agent if specified
  },
});
```

### 2. Backend Changes (OpenCodeViewProvider.ts)

#### Handle New Messages

Add handling for agent-related messages:
- `getAgents` - request to fetch available agents
- `setAgent` - update the selected agent

```typescript
case 'getAgents':
  const agents = await this.openCodeService.getAgents();
  this._view.webview.postMessage({ 
    type: 'agentList', 
    agents: agents 
  });
  break;

case 'setAgent':
  // Just pass through - will be used when sending prompt
  break;
```

Update `sendPrompt` message handler to include agent:

```typescript
case 'sendPrompt':
  await this.openCodeService.sendPromptStreaming(
    message.text,
    (event) => { /* ... */ },
    undefined,
    message.agent // Pass selected agent
  );
  break;
```

### 3. Frontend Changes (App.tsx)

#### Add State for Agents

```typescript
const [agents, setAgents] = createSignal<Agent[]>([]);
const [selectedAgent, setSelectedAgent] = createSignal<string | null>(null);

interface Agent {
  name: string;
  description?: string;
  mode: "subagent" | "primary" | "all";
  builtIn: boolean;
}
```

#### Update Message Handlers

Add handling for `agentList` message:

```typescript
case 'agentList':
  setAgents(message.agents || []);
  // Select first agent by default if none selected
  if (!selectedAgent() && message.agents.length > 0) {
    setSelectedAgent(message.agents[0].name);
  }
  break;
```

Request agents on mount:

```typescript
onMount(() => {
  // ... existing message handler setup ...
  
  // Request agent list
  vscode.postMessage({ type: 'getAgents' });
});
```

#### Update Submit Handler

Include selected agent when sending prompt:

```typescript
const handleSubmit = (e: Event) => {
  e.preventDefault();
  if (!input().trim() || isThinking()) return;

  vscode.postMessage({
    type: 'sendPrompt',
    text: input(),
    agent: selectedAgent(), // Include selected agent
  });

  setInput("");
};
```

#### Update Input Rendering

Modify `renderInput()` to include agent switcher:

```typescript
const renderInput = () => (
  <form class="input-container" onSubmit={handleSubmit}>
    <div class="textarea-wrapper">
      <textarea
        ref={inputRef!}
        class="prompt-input"
        // Add padding-bottom for button row
        style={{ "padding-bottom": "32px" }}
        placeholder={isReady() ? "Ask OpenCode anything..." : "Initializing..."}
        value={input()}
        onInput={(e) => setInput(e.currentTarget.value)}
        onKeyDown={handleKeyDown}
        disabled={!isReady() || isThinking()}
      />
      <div class="input-buttons">
        <Show when={agents().length > 0}>
          <AgentSwitcher />
        </Show>
        <button
          type="submit"
          class="shortcut-button shortcut-button--secondary"
          disabled={!isReady() || isThinking() || !input().trim()}
          aria-label="Submit (Cmd+Enter)"
        >
          ⌘⏎
        </button>
      </div>
    </div>
  </form>
);
```

#### Add Agent Switcher Component

```typescript
const AgentSwitcher = () => {
  const [isOpen, setIsOpen] = createSignal(false);
  
  const currentAgent = () => {
    const name = selectedAgent();
    return agents().find(a => a.name === name);
  };
  
  return (
    <div class="agent-switcher">
      <button
        type="button"
        class="agent-switcher-button"
        onClick={() => setIsOpen(!isOpen())}
        aria-label="Switch agent"
      >
        {currentAgent()?.name || 'Select Agent'}
      </button>
      <Show when={isOpen()}>
        <div class="agent-dropdown">
          <For each={agents()}>
            {(agent) => (
              <button
                type="button"
                class={`agent-option ${selectedAgent() === agent.name ? 'selected' : ''}`}
                onClick={() => {
                  setSelectedAgent(agent.name);
                  setIsOpen(false);
                  vscode.postMessage({ type: 'setAgent', agent: agent.name });
                }}
              >
                <div class="agent-option-name">{agent.name}</div>
                <Show when={agent.description}>
                  <div class="agent-option-description">{agent.description}</div>
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
};
```

### 4. CSS Changes (App.css)

#### Update Input Container

```css
/* Make room for button row at bottom */
.textarea-wrapper {
  position: relative;
  width: 100%;
}

.prompt-input {
  /* Keep existing styles */
  padding-bottom: 32px; /* Room for buttons */
}

/* Button row at bottom of input */
.input-buttons {
  position: absolute;
  bottom: 4px;
  left: 4px;
  right: 4px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}

/* Shortcut button - secondary style */
.shortcut-button--secondary {
  margin-left: auto; /* Push to right */
  padding: 4px 8px;
  border: 1px solid var(--vscode-button-border);
  border-radius: 3px;
  background-color: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  font-family: var(--vscode-font-family);
  font-size: 11px;
  cursor: pointer;
  opacity: 0.8;
  transition: opacity 0.15s, background-color 0.15s;
}

.shortcut-button--secondary:hover:not(:disabled) {
  opacity: 1;
  background-color: var(--vscode-button-secondaryHoverBackground);
}
```

#### Agent Switcher Styles

```css
/* Agent switcher - quiet style */
.agent-switcher {
  position: relative;
}

.agent-switcher-button {
  padding: 4px 8px;
  border: none;
  border-radius: 3px;
  background-color: transparent;
  color: var(--vscode-foreground);
  font-family: var(--vscode-font-family);
  font-size: 11px;
  cursor: pointer;
  opacity: 0.6;
  transition: opacity 0.15s, background-color 0.15s;
}

.agent-switcher-button:hover {
  opacity: 1;
  background-color: var(--vscode-list-hoverBackground);
}

/* Dropdown */
.agent-dropdown {
  position: absolute;
  bottom: 100%;
  left: 0;
  margin-bottom: 4px;
  min-width: 200px;
  max-height: 300px;
  overflow-y: auto;
  background-color: var(--vscode-dropdown-background);
  border: 1px solid var(--vscode-dropdown-border);
  border-radius: 4px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  z-index: 1000;
}

.agent-option {
  width: 100%;
  padding: 8px 12px;
  border: none;
  background-color: transparent;
  color: var(--vscode-dropdown-foreground);
  font-family: var(--vscode-font-family);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.15s;
}

.agent-option:hover {
  background-color: var(--vscode-list-hoverBackground);
}

.agent-option.selected {
  background-color: var(--vscode-list-activeSelectionBackground);
  color: var(--vscode-list-activeSelectionForeground);
}

.agent-option-name {
  font-weight: 500;
  margin-bottom: 2px;
}

.agent-option-description {
  font-size: 11px;
  opacity: 0.8;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
```

## Implementation Plan

1. ✅ Research OpenCode API and current UI
2. ✅ Write spec document
3. ⏳ Update OpenCodeService.ts with agent methods
4. ⏳ Update OpenCodeViewProvider.ts with agent message handlers
5. ⏳ Update App.tsx with agent state and switcher component
6. ⏳ Update App.css with new styles
7. ⏳ Test with workspace that has multiple agents configured
8. ⏳ Update TODO.md and commit

## Testing Strategy

1. Create a test workspace with `opencode.json` containing multiple agents:
   ```json
   {
     "agents": {
       "general": {
         "description": "General purpose assistant",
         "mode": "primary"
       },
       "code": {
         "description": "Code-focused assistant", 
         "mode": "primary"
       }
     }
   }
   ```

2. Verify agent list loads on extension activation
3. Verify switching between agents persists selection
4. Verify prompts are sent with correct agent parameter
5. Verify UI updates correctly (dropdown, selection state)

## Progress

- [x] Research completed
- [x] Spec written
- [x] Implementation completed
  - [x] Backend: Added `getAgents()` method to OpenCodeService
  - [x] Backend: Updated `sendPrompt` and `sendPromptStreaming` to accept agent parameter
  - [x] Backend: Added `getAgents` and updated `sendPrompt` handlers in OpenCodeViewProvider
  - [x] Frontend: Added Agent interface and state management
  - [x] Frontend: Added `AgentSwitcher` component with dropdown
  - [x] Frontend: Updated input rendering to include agent switcher and button row
  - [x] Frontend: Request agents on mount and select first agent by default
  - [x] Frontend: Include selected agent when sending prompts
  - [x] CSS: Added `.input-buttons` layout for button row
  - [x] CSS: Added `.shortcut-button--secondary` styling
  - [x] CSS: Added agent switcher and dropdown styles
  - [x] Build: Successfully compiled with no errors

## What Was Implemented

### Backend (OpenCodeService.ts)
- Added `agents: Agent[]` property to track available agents
- Added `getAgents()` method that:
  - Calls `app.agents()` API
  - Filters to only "primary" or "all" mode agents
  - Returns filtered list
- Updated `sendPrompt()` to accept optional `agent?: string` parameter
- Updated `sendPromptStreaming()` to accept optional `agent?: string` parameter
- Both methods now include agent in the prompt body when specified

### Backend (OpenCodeViewProvider.ts)
- Added `getAgents` message handler that:
  - Calls `getAgents()` from service
  - Sends agent list to webview via `agentList` message
  - Sends empty array on error
- Updated `sendPrompt` message handler to pass `message.agent` to service

### Frontend (App.tsx)
- Added `Agent` interface with name, description, mode, builtIn properties
- Added `agents` and `selectedAgent` signals for state management
- Added `agentList` message handler that:
  - Sets agents from message
  - Auto-selects first agent if none selected
- Added `AgentSwitcher` component with:
  - Dropdown toggle button showing current agent name
  - Dropdown menu with all available agents
  - Agent option buttons with name and description
  - Click-outside-to-close behavior
  - Visual selected state
- Updated `renderInput()` to:
  - Add padding-bottom to textarea for button row
  - Show agent switcher when agents available
  - Include both agent switcher and submit button in `.input-buttons` row
  - Apply secondary styling to submit button
- Updated `handleSubmit()` to include `agent: selectedAgent()` in message
- Added `getAgents` request on mount

### CSS (App.css)
- Added `.input-buttons` class for absolute-positioned button row
- Updated `.shortcut-button` to use margin-left: auto
- Added `.shortcut-button--secondary` with VSCode secondary button styling
- Added `.agent-switcher` with quiet button styling (opacity 0.6)
- Added `.agent-dropdown` with popup positioning and VSCode dropdown styling
- Added `.agent-option` with hover and selected states
- Added `.agent-option-name` and `.agent-option-description` for layout

## Testing Needed

1. Create test workspace with multiple agents in `opencode.json`
2. Verify agent list loads and displays in dropdown
3. Verify agent selection persists and is sent with prompts
4. Verify UI layout and styling matches spec
5. Test with 0 agents (dropdown should not appear)
6. Test with 1 agent (should auto-select)
7. Test clicking outside to close dropdown

## Known Limitations

- No color customization from agent config (OpenCode API doesn't provide color in Agent type)
- Agent selection doesn't persist across extension reloads
- No visual indicator of which agent responded (all responses look the same)
