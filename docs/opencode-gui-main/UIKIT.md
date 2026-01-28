# UI Kit

A standalone UI development environment for OpenCode VSCode extension components.

## Purpose

The UI Kit allows you to develop and test UI components in isolation without needing to rebuild and reload the VSCode extension every time. It provides:

- **Hot reload**: Changes to CSS and components instantly reflect in the browser
- **Fake data**: Pre-populated with sample messages, sessions, and agents
- **Control panel**: Toggle states (thinking indicator, messages, etc.) for testing different scenarios
- **No backend required**: Runs entirely in the browser with simulated responses

## Usage

### Start the UI Kit

```bash
npm run uikit
```

This will open a browser window at `http://localhost:5173/src/webview/uikit.html` with hot reload enabled.

### Making Changes

1. Edit any component in `src/webview/components/`
2. Edit styles in `src/webview/App.css`
3. Changes will automatically reflect in the browser
4. No need to reload the VSCode extension!

### Control Panel

The UI Kit includes a control panel at the top with buttons to:

- **Start/Stop Thinking**: Toggle the thinking indicator
- **Clear Messages**: Remove all messages from the view
- **Load Fake Messages**: Restore the default fake conversation

### Adding More Fake Data

Edit `src/webview/uikit.tsx` to add more:

- Messages (user and assistant)
- Tool calls (read, write, bash, grep, etc.)
- Sessions
- Agents

## Files

- `src/webview/uikit.html` - HTML entry point
- `src/webview/uikit.tsx` - Main UI Kit component with fake data
- `vite.config.ts` - Vite configuration (includes uikit entry point)

## Tips

- Use this for rapid UI/CSS iteration
- Test different states and edge cases easily
- Verify visual changes before testing in the full extension
- Great for taking screenshots or demos
