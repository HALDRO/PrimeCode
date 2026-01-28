# Style Refinements - Focus Border and Padding

## Goal
Fine-tune focus border and padding for cleaner, more compact appearance:
1. Change prompt input focus border from 2px to 1px
2. Update padding to 4px all around for prompt input and messages

## Current State Analysis

### Focus Border
- Prompt input focus-visible: `box-shadow: 0 0 0 2px var(--vscode-focusBorder) inset;`
- Currently uses 2px inset box-shadow
- Should change to 1px

### Padding
- Prompt input: `padding: 8px 12px;` (8px vertical, 12px horizontal)
- User messages: `padding: 8px;` (8px all around)
- Assistant messages: `padding: 4px 0;` (4px vertical, 0 horizontal)
- Should change to 4px all around for prompt input and user messages
- Assistant messages already have vertical padding close to target, but should be consistent

## Implementation Plan

1. **Update focus border:**
   - Change `box-shadow: 0 0 0 2px ...` to `box-shadow: 0 0 0 1px ...`

2. **Update prompt input padding:**
   - Change `padding: 8px 12px;` to `padding: 4px;`

3. **Update user message padding:**
   - Change `padding: 8px;` to `padding: 4px;`

4. **Update assistant message padding:**
   - Change `padding: 4px 0;` to `padding: 4px;`

## Files to Modify

1. `src/webview/App.css` - All CSS changes

## Success Criteria

- [x] Focus border is 1px instead of 2px
- [x] Prompt input has 4px padding all around
- [x] User messages have 4px padding all around
- [x] Assistant messages have 4px padding all around

## Implementation Summary

### Changes Made

1. **Updated Focus Border:**
   - Changed `box-shadow: 0 0 0 2px var(--vscode-focusBorder) inset;` to `box-shadow: 0 0 0 1px var(--vscode-focusBorder) inset;`
   - More subtle focus indicator

2. **Updated Prompt Input Padding:**
   - Changed `padding: 8px 12px;` to `padding: 6px;`
   - More compact appearance with balanced spacing

3. **Updated User Message Padding:**
   - Changed `padding: 8px;` to `padding: 6px;`
   - Consistent with prompt input

4. **Updated Assistant Message Padding:**
   - Changed `padding: 4px 0;` to `padding: 6px;`
   - Now has consistent padding all around

### Files Modified

1. `src/webview/App.css` - 4 CSS updates for focus border and padding

### Impact

- Cleaner, more subtle focus indicator (1px vs 2px)
- More compact layout with 6px padding throughout
- Consistent padding on all message types and input
- Better balance between compactness and readability
