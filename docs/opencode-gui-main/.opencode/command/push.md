---
description: Make a git commit and push. Create or update PR with appropriate title and description
---

## Current State

**Branch:** !`git branch --show-current`

**Existing PR:** !`gh pr view --json number -q '.number' 2>/dev/null || echo "None"`

### Uncommitted Changes
!`git status --short`

### Recent Commits (not on main)
!`git log main..HEAD --oneline 2>/dev/null || echo "On main or no commits ahead"`

---

## Instructions

If on main, checkout a new branch first. Commit the changes in the current branch. Use gh cli to see if a PR exists already. If it doesn't, create one with an appropriate title and description. If a PR does exist, query the current title and description, and update it if appropriate. Then push the changes. For any follow-up edits in this session, continue to commit and push and update the PR if appropriate.
