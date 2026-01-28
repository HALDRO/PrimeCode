# Button Spacing and Positioning Refinements

## Goal
Refine the action button layout:
1. Reduce spacing between buttons and prompt input from 8px to 4px
2. Move buttons above the prompt input when in has-messages state (bottom position)

## Current State Analysis

### Button Spacing
- `.input-buttons` has `margin-top: 8px`
- Buttons appear below the textarea in document flow
- Should reduce to 4px for tighter spacing

### Button Positioning
- Currently buttons always appear below textarea
- Empty state: Input at top, buttons below
- Has-messages state: Input at bottom, buttons still below
- Should move buttons above textarea when at bottom

### Current HTML Structure
```tsx
<form class="input-container">
  <textarea class="prompt-input" />
  <div class="input-buttons">
    <AgentSwitcher />
    <button>⌘⏎</button>
  </div>
</form>
```

## Implementation Plan

1. **Reduce button spacing:**
   - Change `margin-top: 8px` to `margin-top: 4px` in `.input-buttons`

2. **Reorder elements for has-messages state:**
   - Use CSS `flex-direction: column-reverse` on `.input-container` when in has-messages state
   - This will flip the order: buttons on top, textarea on bottom
   - Adjust margin from `margin-top` to `margin-bottom` for has-messages state

3. **Alternative approach (if needed):**
   - Could conditionally render button order in TSX using Show/When
   - But CSS approach is cleaner and doesn't duplicate code

## CSS Strategy

```css
.input-buttons {
  margin-top: 4px;
}

.app--has-messages .input-container {
  display: flex;
  flex-direction: column-reverse;
}

.app--has-messages .input-buttons {
  margin-top: 0;
  margin-bottom: 4px;
}
```

## Files to Modify

1. `src/webview/App.css` - Update button spacing and add column-reverse for has-messages state

## Success Criteria

- [x] Button spacing reduced to 4px
- [x] Buttons appear below input in empty state
- [x] Buttons appear above input in has-messages state
- [x] Visual flow feels natural in both states

## Implementation Summary

### Changes Made

1. **Reduced Button Spacing:**
   - Changed `.input-buttons` `margin-top` from 8px to 4px
   - Tighter spacing between input and buttons

2. **Added Flexbox to Input Container:**
   - Added `display: flex` and `flex-direction: column` to `.input-container`
   - Maintains normal top-to-bottom order in empty state

3. **Reversed Order for Has-Messages State:**
   - Added `flex-direction: column-reverse` to `.app--has-messages .input-container`
   - Flips the order: buttons now appear above textarea when at bottom

4. **Adjusted Margin for Has-Messages State:**
   - Added `.app--has-messages .input-buttons` with `margin-top: 0` and `margin-bottom: 4px`
   - Ensures consistent 4px spacing in reversed layout

### Files Modified

1. `src/webview/App.css` - 3 CSS updates for spacing and flex-direction

### Impact

- Tighter 4px spacing between buttons and input
- Empty state (top): textarea → buttons (natural reading order)
- Has-messages state (bottom): buttons → textarea (buttons easily accessible above input)
- More ergonomic layout when input is at bottom of screen
