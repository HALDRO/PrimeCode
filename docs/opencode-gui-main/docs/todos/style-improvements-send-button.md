# Style Improvements: Send Button and Keyboard Shortcut

## Goal

Improve the prompt input area with the following changes:
1. Remove the "Send" button
2. Remove the text drag handle (resize: vertical)
3. Make the text editor focus outline blue
4. Add a small button with text ⌘⏎ in the bottom right of the textbox
5. Submit on either button click or Cmd+Enter

## Current Implementation

### App.tsx
- Lines 96-114: Form with textarea and send button
- Lines 87-92: `handleKeyDown` currently submits on Enter (without Shift)
- Lines 63-85: `handleSubmit` function

### App.css
- Lines 29-56: `.prompt-input` styles
  - Line 40: `resize: vertical` (drag handle)
  - Lines 44-46: Focus border uses `var(--vscode-focusBorder)`
- Lines 57-77: `.send-button` styles (to be removed)

## Design Specification

### 1. Remove Send Button
- Remove `<button type="submit">` from App.tsx (lines 107-113)
- Remove `.send-button` styles from App.css (lines 57-77)
- Adjust `.input-container` flex layout since no button

### 2. Remove Text Drag Handle
- Change `resize: vertical` to `resize: none` in `.prompt-input`

### 3. Blue Focus Outline
- VSCode's `--vscode-focusBorder` should already be blue, but we can ensure it's prominent
- Current implementation uses border-color change on focus (line 45)
- Could use outline instead for more visibility, or keep border approach

### 4. Add ⌘⏎ Button in Bottom Right
- Create a new button positioned absolutely inside the textarea container
- Style it to be subtle/quiet (low opacity, small, no background by default)
- Position: bottom-right corner with small padding (e.g., 4px from edges)
- Text content: "⌘⏎" (Command + Return symbols)
- Should be clickable and trigger submit

**Implementation approach:**
- Wrap textarea in a positioned container (position: relative)
- Add button with position: absolute, bottom: 4px, right: 4px
- Style with opacity: 0.5, small font, no border/background initially
- Hover effect: opacity: 1

### 5. Cmd+Enter to Submit
- Modify `handleKeyDown` to check for `e.key === 'Enter' && (e.metaKey || e.ctrlKey)`
- Keep Shift+Enter for new line (default textarea behavior)
- Remove plain Enter submit (current behavior)

## Implementation Plan

1. **App.tsx changes:**
   - Wrap textarea in a div with `position: relative`
   - Add small button inside wrapper, positioned absolutely
   - Update `handleKeyDown` to require Cmd/Ctrl modifier
   - Remove send button from JSX

2. **App.css changes:**
   - Remove `.send-button` styles
   - Update `.input-container` (no flex gap needed)
   - Change `.prompt-input` resize to none
   - Add `.textarea-wrapper` styles (position: relative)
   - Add `.shortcut-button` styles (quiet, positioned bottom-right)
   - Optional: enhance focus outline to ensure it's blue/visible

## Progress

### Completed
✅ All requirements successfully implemented:

1. **Removed Send Button** - Replaced traditional send button with subtle keyboard shortcut indicator
2. **Removed Text Drag Handle** - Changed `resize: vertical` to `resize: none` in textarea
3. **Blue Focus Outline** - Implemented 2px solid blue (#007ACC) outline on focus for clear visual feedback
4. **Added ⌘⏎ Button** - Positioned absolutely in bottom-right of textarea with quiet styling
5. **Cmd+Enter Submit** - Updated keyboard handler to require Cmd/Ctrl + Enter (Shift+Enter for new lines)

### Implementation Details

**App.tsx changes:**
- Wrapped textarea in `textarea-wrapper` div with `position: relative`
- Added `shortcut-button` positioned absolutely with ⌘⏎ text
- Modified `handleKeyDown` to check for `e.metaKey || e.ctrlKey` instead of plain Enter
- Removed old send button JSX

**App.css changes:**
- Removed `.send-button` styles
- Added `.textarea-wrapper` with relative positioning
- Updated `.prompt-input`: changed resize to none, added right padding (48px) for button space, added box-sizing
- Updated `.prompt-input:focus`: blue outline (#007ACC) with 2px width
- Added `.shortcut-button`: quiet styling with 0.5 opacity, positioned bottom-right, hover effects

### Build Status
✅ Build successful - no errors or warnings
✅ TypeScript compilation passed
✅ All diagnostics clean

### Issues Encountered
None - implementation went smoothly

### Remaining Work
None - all requirements completed
