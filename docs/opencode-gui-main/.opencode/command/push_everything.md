---
description: Stage ALL changes, commit, and push. Create or update PR with appropriate title and description
---

## Current State

**Branch:** !`git branch --show-current`

**Existing PR:** !`gh pr view --json number -q '.number' 2>/dev/null || echo "None"`

### All Uncommitted Changes (staged and unstaged)
!`git status --short`

### Recent Commits (not on main)
!`git log main..HEAD --oneline 2>/dev/null || echo "On main or no commits ahead"`

---

## Instructions

If on main, checkout a new branch first. Stage ALL changes in the repository (not just session changes) with `git add -A`. Commit the changes with an appropriate message summarizing all the work. Use gh cli to see if a PR exists already. If it doesn't, create one with an appropriate title and description. If a PR does exist, query the current title and description, and update it if appropriate. Then push the changes.
