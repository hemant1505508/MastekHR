# Charter: HR Onboarding Agent (AGT-002)

Published v1 · content hash 7a6dc300 · by sana-tl · 2026-11-03

## Problem

HR Onboarding Officers and Hiring Managers spend hours answering the same onboarding questions, chasing overdue pre-employment checks and working out which access a starter needs, with up to 2,000 starters in a peak month.

## Measures

| Measure | Threshold | Basis |
|---|---|---|
| Query deflection | at least 50% | From HR-agent-and-stories.xlsx, sheet Agents, row 2 |
| Citation accuracy | at least 95% | From HR-agent-and-stories.xlsx, sheet Agents, row 2 |
| Hallucination rate | at most 2% | From HR-agent-and-stories.xlsx, sheet Agents, row 2 |
| Reminder human approval | 100% | From HR-agent-and-stories.xlsx, sheet Agents, row 2 |
| Sensitive question handover | 100% | From HR-agent-and-stories.xlsx, sheet Agents, row 2 |
| PII in agent logs | 0% | From HR-agent-and-stories.xlsx, sheet Agents, row 2 |

## Owner

Hemant

## In scope

- Answering onboarding questions from approved HR policies
- Summarising a starter's onboarding and check status
- Drafting reminders for overdue checks for an HR Officer to approve
- Suggesting a role profile from a job description
- Handing over to a human HR Officer

## Out of scope

- Deciding whether a starter is cleared to start
- Approving access or overriding a check
- Sending messages without human approval
- Employment law, grievance or health advice
- Changing records in ESR

## Regions

- UK

## Product classes

- Conversational assistant
