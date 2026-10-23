#!/usr/bin/env bash
# Bootstrap all GitHub labels for Wingman-POC.
# Run once on a fresh repo. Re-running will error on existing labels — that's expected.

set -e

gh label create "bug"              --color "d73a4a" --description "Something isn't working"
gh label create "documentation"    --color "0075ca" --description "Improvements or additions to documentation"
gh label create "duplicate"        --color "cfd3d7" --description "This issue or pull request already exists"
gh label create "enhancement"      --color "a2eeef" --description "New feature or request"
gh label create "good first issue" --color "7057ff" --description "Good for newcomers"
gh label create "help wanted"      --color "008672" --description "Extra attention is needed"
gh label create "invalid"          --color "e4e669" --description "This doesn't seem right"
gh label create "question"         --color "d876e3" --description "Further information is requested"
gh label create "wontfix"          --color "ffffff" --description "This will not be worked on"
gh label create "needs-info"       --color "d4c5f9" --description "Waiting on reporter for more information"
gh label create "needs-triage"     --color "ededed" --description "Maintainer needs to evaluate this issue"
gh label create "ready-for-agent"  --color "0e8a16" --description "Fully specified, ready for an AFK agent"
gh label create "ready-for-human"  --color "1d76db" --description "Requires human implementation"
gh label create "POC"              --color "0075ca" --description ""
gh label create "in-progress"      --color "e4e669" --description ""
gh label create "blocked"          --color "d93f0b" --description ""
gh label create "feature"          --color "a2eeef" --description ""
gh label create "chore"            --color "fbca04" --description ""
gh label create "spike"            --color "f9d0c4" --description ""
gh label create "area: server"     --color "c2e0c6" --description ""
gh label create "area: ui"         --color "bfd4f2" --description ""
gh label create "area: ai"         --color "c5def5" --description ""
gh label create "area: eval"       --color "ededed" --description ""
gh label create "area: infra"      --color "f9e4d4" --description ""
gh label create "area: db"         --color "fef2c0" --description ""
gh label create "area: shared"     --color "d4c5f9" --description ""
gh label create "area: design"     --color "e99695" --description ""
gh label create "in-review"        --color "bfd4f2" --description "PR open, awaiting review"
