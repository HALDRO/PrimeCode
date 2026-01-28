# Quick Start Guide

## Running the Extension for the First Time

1. **Install dependencies** (if you haven't already):
   ```bash
   npm install
   ```

2. **Build the extension**:
   ```bash
   npm run build
   ```

3. **Start watch mode** (in a terminal):
   ```bash
   npm run watch
   ```
   Keep this terminal running - it will rebuild automatically when you make changes.

4. **Press F5** in VSCode/Cursor
   - In the "Run and Debug" dropdown, select "Run Extension"
   - Press F5 or click the green play button
   - A new "Extension Development Host" window will open

5. **Open the OpenCode sidebar**:
   - In the new window, look for the OpenCode icon in the Activity Bar (left sidebar)
   - Click it to open the OpenCode panel
   - You should see "Hello from Opencode"

## Development Loop

### For Extension Code Changes (TypeScript backend)
1. Make changes to files in `src/` (e.g., `extension.ts`, `OpenCodeViewProvider.ts`)
2. Save the file
3. In the Extension Development Host window:
   - Press `Cmd+R` (Mac) or `Ctrl+R` (Windows/Linux)
   - Or open Command Palette (`Cmd+Shift+P`) and run "Developer: Reload Window"

### For Webview UI Changes (React frontend)
1. Make changes to files in `src/webview/` (e.g., `App.tsx`, `App.css`)
2. Save the file
3. Changes should hot-reload automatically in the sidebar!
   - No need to reload the window

## Debugging

### Extension Code
- Set breakpoints in `src/extension.ts` or `src/OpenCodeViewProvider.ts`
- Debug panel will show variables and call stack

### Webview Code
1. In the Extension Development Host window, open Command Palette
2. Run "Developer: Toggle Developer Tools"
3. In the Console, select "active frame" from the dropdown
4. Now you can debug the React code, see console.logs, etc.

## Building for Production
```bash
npm run build
```
This creates optimized builds in:
- `dist/` - Extension code
- `out/` - Webview UI

## Troubleshooting

### Extension doesn't appear in Activity Bar
- Check the Debug Console in the main VSCode window for errors
- Make sure `npm run build` completed successfully
- Try closing and reopening the Extension Development Host window

### Webview shows blank/white screen
- Open Developer Tools (Command Palette > "Developer: Toggle Developer Tools")
- Check Console for errors
- Make sure `out/main.js` and `out/main.css` exist

### Hot reload not working
- Make sure `npm run watch` is running (it starts automatically with F5)
- Check the Terminal panel in the main VSCode window
- Try manually running `npm run watch` in a terminal
