# .github

Org-wide shared GitHub Actions tooling for `analitiq-ai` repositories.

This repo hosts reusable workflows (`on: workflow_call`) and the scripts they
depend on, so CI logic shared across repos is defined once and referenced
from a thin caller workflow in each consuming repo, rather than copy-pasted.

## Contents

- `.github/workflows/ai-review.yml` — reusable workflow: an AI-generated code
  review posted as inline PR comments, triggered by a `/review` comment.
