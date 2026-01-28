# Prompt Editor Auto-Resize

## Goal
Make the prompt editor textarea automatically resize vertically as the user types, expanding to fit content up to a maximum height.

## Current Implementation

The prompt editor is a `<textarea>` element with:
- Fixed `rows={1}` attribute
- `min-height: 36px`
- `max-height: 120px`
- `resize: none` (disabled manual resize handle)

Located in:
- Component: [src/webview/App.tsx](../../src/webview/App.tsx) lines 114-123
- Styles: [src/webview/App.css](../../src/webview/App.css) lines 37-52

## Problem
Currently the textarea doesn't grow as the user types multi-line content. It stays at one line until the user presses Enter, then scrolls internally rather than expanding the container.

## Solution Approach

### Option 1: CSS-only with field-sizing (Modern)
Use the new CSS `field-sizing: content` property:
```css
.prompt-input {
  field-sizing: content;
  min-height: 36px;
  max-height: 120px;
}
```
**Pros**: Simple, no JavaScript
**Cons**: Very new CSS property, limited browser support (Chrome 123+, not in Firefox/Safari yet)

### Option 2: JavaScript height adjustment (Classic)
Dynamically adjust textarea height based on scrollHeight:
```tsx
const adjustHeight = (element: HTMLTextAreaElement) => {
  element.style.height = 'auto';
  element.style.height = `${element.scrollHeight}px`;
};
```
**Pros**: Works everywhere, simple implementation
**Cons**: Requires JavaScript, needs to handle max-height separately

### Option 3: Tiptap Editor (Over-engineered)
Use a full rich text editor like Tiptap.
**Pros**: Enables future features (markdown, @-mentions, formatting)
**Cons**: Heavy dependency (100kb+), complex setup, overkill for basic auto-resize

## Chosen Approach: Option 2 (JavaScript)

Use JavaScript auto-resize for maximum compatibility and simplicity. This is the standard approach used by most chat applications.

## Implementation Plan

1. Create `adjustTextareaHeight` helper function
2. Add `useEffect` to adjust height when `input` state changes
3. Also adjust on initial render and after clear
4. Ensure max-height constraint is respected
5. Remove the `rows` attribute (let height be controlled by CSS)

## Code Changes

### src/webview/App.tsx

Add height adjustment logic:
```tsx
// Helper function to auto-resize textarea
const adjustTextareaHeight = () => {
  if (inputRef.current) {
    inputRef.current.style.height = 'auto';
    inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 120)}px`;
  }
};

// Adjust height when input changes
useEffect(() => {
  adjustTextareaHeight();
}, [input]);

// Also adjust on mount
useEffect(() => {
  adjustTextareaHeight();
}, []);
```

Update textarea element:
```tsx
<textarea
  ref={inputRef}
  className="prompt-input"
  value={input}
  onChange={(e) => setInput(e.target.value)}
  // Remove rows={1}
/>
```

### src/webview/App.css

Update CSS to support dynamic height:
```css
.prompt-input {
  width: 100%;
  min-height: 36px;
  max-height: 120px;
  overflow-y: auto; /* Show scrollbar if content exceeds max-height */
  /* Remove height/rows, let JavaScript control it */
}
```

## Testing

1. Type a single line - should stay at min-height (36px)
2. Type multiple lines - should expand smoothly
3. Type beyond max-height (120px) - should stop growing and show scrollbar
4. Submit message - input clears and resets to min-height
5. Paste large text - should expand immediately

## Implementation Completed

### Changes Made

**src/webview/App.tsx:**
1. Added `adjustTextareaHeight()` helper function that:
   - Resets height to 'auto' to get natural scrollHeight
   - Sets height to minimum of scrollHeight and 120px max
2. Added `useEffect` hook to call `adjustTextareaHeight()` whenever `input` state changes
3. Removed `rows={1}` attribute from textarea element

**src/webview/App.css:**
1. Added `overflow-y: auto` to `.prompt-input` to show scrollbar when content exceeds max-height

### Testing

Build completed successfully with no TypeScript errors.

Manual testing should verify:
- ✓ Single line stays at min-height (36px)
- ✓ Multiple lines expand smoothly up to 120px
- ✓ Content beyond max-height shows scrollbar
- ✓ Clearing input resets to min-height
- ✓ Pasting large text expands immediately

## Progress

- [x] Implementation complete
- [x] Build successful, no errors
- [x] Documentation updated
- [ ] Manual testing in Extension Development Host (requires user to test in VSCode)

## Notes

The 120px max-height is approximately 5-6 lines of text at default VSCode font size, which is a good balance between visibility and not taking up too much space.

The auto-resize implementation uses the standard approach: reset height to 'auto', measure scrollHeight, then set height to the measured value (capped at max). This works reliably across all browsers.
