---
name: project-policy
description: The policies, standards, guidelines and customer Guardrails that apply to MastekHR, at the versions it follows. Read before designing, building or reviewing code on this project.
---

# Policies and Guardrails in force: MastekHR

Domain: Media & Publishing. Region: UK. 53 entries across 2 levels. Mastek's own Guardrails are a fourth source of rules for this project and are listed under the Customer level.

## How to use this

- `in-force.md` lists every entry and the version this project follows. Cite an entry by its id and version when you explain a design choice.
- These are the project's rules, not suggestions. Where code would break one, say so and ask the Tech Lead; do not work around it.
- Acts and regulations follow current law and have no version.
- An entry flagged as earlier than the current version, or below the lowest allowed version, is a note for the Delivery Manager and the Tech Lead. Mention it; do not change it.

## This package is locked

Do not edit anything in `.claude/skills/project-policy/` or `.workbench/policy.lock.json`. They are owned by Enterprise Governance (see `.workbench/CODEOWNERS.snippet`). They are replaced only by downloading the package again from the Workbench, and the lock records exactly what was in force when it was made.

Reference only: no secrets, no test sets, and no project documents. The project's own knowledge is in the `project-context` package.
