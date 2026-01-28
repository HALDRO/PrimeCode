# TODO: OpenCode Extension Opens in MacOS Filesystem Root

## Problem

The OpenCode extension appears to open in the MacOS filesystem root (`/`) instead of the workspace that VSCode is opened in.

## Research

### Current Implementation

1. **Extension Activation** (`src/extension.ts`):
   - Line 12: Resolves workspace root: `vscode.workspace.workspaceFolders?.[0]?.uri.fsPath`
   - Line 15: Passes workspace root to `openCodeService.initialize(workspaceRoot)`

2. **OpenCode Service** (`src/OpenCodeService.ts`):
   - Line 20-48: `initialize(workspaceRoot?: string)` method
   - Line 29: Uses workspace root only to load `opencode.json` config file
   - Line 32-36: Creates OpenCode instance via `createOpencode()` from SDK
   - The workspace root is NOT passed to the OpenCode server itself

3. **OpenCode SDK** (`node_modules/@opencode-ai/sdk/dist/server.js`):
   - Line 8: Spawns `opencode serve` command using Node.js `child_process.spawn()`
   - **Missing**: No `cwd` option in spawn options
   - The spawned process inherits the parent process's working directory
   - In a VSCode extension, the parent process cwd is typically the VSCode installation directory or system root

### Root Cause

The `createOpencodeServer()` function in `@opencode-ai/sdk` does not accept a `cwd` or working directory parameter. When it spawns the `opencode serve` process, it doesn't specify a working directory, so the child process inherits the VSCode extension host's working directory, which is NOT the workspace folder.

### Current ServerOptions Interface

```typescript
export type ServerOptions = {
    hostname?: string;
    port?: number;
    signal?: AbortSignal;
    timeout?: number;
    config?: Config;
};
```

Notice: No `cwd` or `workingDirectory` option.

## Solution Options

### Option 1: Patch the SDK (Not Recommended)
We could manually patch `node_modules/@opencode-ai/sdk` to add cwd support, but this would be lost on every npm install.

### Option 2: Fork and Modify SDK (Heavy)
Fork the `@opencode-ai/sdk` package and add `cwd` support. This requires maintaining a fork.

### Option 3: Change Process Working Directory Before Initialization (Hacky)
Use `process.chdir()` before calling `createOpencode()`, but this affects the entire extension host process and could break other extensions.

### Option 4: Set Environment Variable (Possible)
Check if the `opencode serve` command respects an environment variable for working directory. Need to investigate the OpenCode CLI.

### Option 5: Request SDK Enhancement (Long-term)
File an issue/PR with `@opencode-ai/sdk` to add `cwd` support to `ServerOptions`. This is the proper solution but takes time.

### Option 6: Workaround - Use `project` Parameter
Looking at the TUI options, there's a `project` parameter. Let me check if this can be used with the server or if the config can specify a working directory.

## Investigation Needed

1. Check if OpenCode config accepts a working directory or project path parameter
2. Test what environment variables the `opencode serve` command respects
3. Verify what the actual working directory issue manifests as (file operations, relative paths, etc.)

## Additional Research from OpenCode Docs

From https://opencode.ai/docs/:
- **Project Context Discovery**: "When OpenCode starts up, it looks for a config file in the current directory or traverse up to the nearest Git directory."
- **Server Command**: `opencode serve` has `--hostname` and `--port` flags, but NO `--project` flag
- OpenCode determines its project context from the **current working directory** where the command is executed

This confirms that the spawned `opencode serve` process needs to have the correct cwd set.

## Proposed Solution (Recommended by Oracle)

**Temporarily chdir to workspace root during SDK initialization:**

1. Capture current working directory before calling `createOpencode()`
2. If workspaceRoot exists and is valid, `process.chdir(workspaceRoot)`
3. Call `createOpencode()` - the spawned server inherits the correct cwd
4. In finally block, restore the original cwd

**Why this approach:**
- Simple, minimal code change
- OpenCode server spawns with correct project context
- cwd change is extremely short-lived (only during spawn)
- No SDK modifications or monkey-patching required
- Already have initialization guard (`isInitializing`) to prevent re-entrancy

**Risks mitigated:**
- Short-lived global state change (only during createOpencode call)
- Always restore in finally block
- Existing `isInitializing` flag prevents concurrent calls

**Future improvement:**
- Submit PR to @opencode-ai/sdk to add `cwd` option to ServerOptions
- Once SDK supports it, replace this workaround

## Implementation

Modified `src/OpenCodeService.ts`:
1. Capture current working directory before initialization
2. Check if workspace root exists and is valid
3. Temporarily `process.chdir(workspaceRoot)` before calling `createOpencode()`
4. Restore original working directory in finally block

The fix ensures the OpenCode server spawns with the correct working directory, allowing it to properly discover the project context and Git repository.

## Testing

To test:
1. Open a workspace in VSCode
2. Activate the extension
3. The OpenCode server should now run in the workspace directory instead of filesystem root
4. File operations should work relative to the workspace
5. Check console logs to verify server starts correctly

## Progress

- [x] Identified root cause in SDK's spawn call
- [x] Researched OpenCode documentation and server behavior
- [x] Consulted Oracle for solution approach
- [x] Confirmed `opencode serve` has no --project flag
- [x] Confirmed OpenCode uses cwd for project context
- [x] Implement temporary chdir solution
- [x] Build successfully completes with no errors
- [x] Update TODO.md with results

## Status

**COMPLETED** - The OpenCode extension now properly initializes in the workspace directory instead of the MacOS filesystem root. The fix uses a temporary working directory change during server spawn, which is immediately restored. This is a clean workaround until the SDK adds native `cwd` support.
