---
description: Get PR review comments and systematically address each one
---

Address PR review comments systematically. The PR number is: $ARGUMENTS (if not provided, use the PR number from the review threads below)

## Review Threads

!`gh api graphql -f query='query { repository(owner: "saffron-health", name: "opencode-gui") { pullRequest(number: '"$(gh pr view --json number -q .number)"') { reviewThreads(first: 100) { nodes { id isResolved isOutdated path line comments(first: 50) { nodes { body author { login } } } } } } } }'`

## Process

1. **Analyze comments**: Review all the feedback above to understand what changes are needed

2. **Address each comment systematically**: For each review comment:
   - Make the requested code changes
   - Verify the changes fix the issue raised
   - Add explanatory comments if the reviewer requested clarification

3. **Quality assurance**: Run type-check and build to ensure all changes are correct

4. **Commit and push**: Stage and commit all changes with an appropriate message and push.

5. **Mark comments resolved**: Resolve all addressed threads using `gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: "THREAD_ID"}) { thread { isResolved } } }'`. Always resolve outdated threads.

## Notes

- Only address reviews from human users; ignore bot reviews (e.g., Claude) unless explicitly requested
- Use sub-agents to handle independent review comments in parallel when possible
- Always verify changes don't introduce new issues
- Focus on the specific issues raised rather than making additional changes
- Mark outdated comments as resolved automatically since they no longer apply to current code
