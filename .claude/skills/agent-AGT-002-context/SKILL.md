---
name: agent-AGT-002-context
description: Use when building or changing HR Onboarding Agent (AGT-002) in MastekHR. It carries this agent's charter, pinned documents, current prompt version, model, test-set names and thresholds, and gates. Read governance-context first.
---

# HR Onboarding Agent (AGT-002) context

Published v1 · content hash 7a6dc300 · by sana-tl · 2026-11-03

Prompt version none yet · model not pinned · pack not finalised yet · built on governance-context v1.

Read the `governance-context` skill first. This skill sits on top of it and never overrides it. It is reference only: read the files below, no tool is needed.

If the repository also holds the `project-policy` skill (the project's own policies and Guardrails: its domain, region and customer), read that too, after governance-context. It is locked and owned by Enterprise Governance. This skill sits on top of it as well, and never overrides it.

## The agent in short

- Problem: HR Onboarding Officers and Hiring Managers spend hours answering the same onboarding questions, chasing overdue pre-employment checks and working out which access a starter needs, with up to 2,000 starters in a peak month.
- Measures: Query deflection at least 50%; Citation accuracy at least 95%; Hallucination rate at most 2%; Reminder human approval 100%; Sensitive question handover 100%; PII in agent logs 0%
- Owner: Hemant
- In scope: Answering onboarding questions from approved HR policies; Summarising a starter's onboarding and check status; Drafting reminders for overdue checks for an HR Officer to approve; Suggesting a role profile from a job description; Handing over to a human HR Officer
- Out of scope: Deciding whether a starter is cleared to start; Approving access or overriding a check; Sending messages without human approval; Employment law, grievance or health advice; Changing records in ESR

## Rules

- Cite the pinned document and its version when you rely on it. Never invent a clause.
- Use the current prompt version and stay on the pinned model. Do not change either in code; they are changed in the workbench by the Tech Lead.
- Do not change the pack, the documents or the thresholds outside the workbench.

## References

- references/charter.md : the charter in full. Read it before you design anything.
- references/documents.md : the pinned documents and their versions. Read it before you cite a rule.
- references/prompt-conventions.md : the current prompt version and the model. Read it before you touch a prompt.
- references/evaluation-thresholds.md : the test sets by name, version and size, and the thresholds. Read it before you judge whether a change is good enough.
- references/gates.md : the gates and who decides each. Read it when you need to know what must be decided before release.

## Out of bounds

- The golden and red-team case content. It is not here, and you must not ask for it or guess it; tuning to the tests defeats them.
- Full document bodies. The documents are named and pinned here; the text is in the knowledge base.
