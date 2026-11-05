# The agent engine (phase 4)

## Pieces
| Piece | File | Job |
|---|---|---|
| Intent suggestion | `src/lib/agent/intents.ts` | Derives, from what is stored, a labelled *suggestion* (kind, confidence, rationale, entities, dated evidence, next steps, confirmation status) and which workflow a **confirmed** intent maps to. |
| Plan schema | `src/lib/agent/schema.ts` | Zod types for `Plan`, `PlanStep`, permissions, tool names, `Reminder`. |
| Planner | `src/lib/agent/planner.ts` | Templates -> a `Plan`; `validatePlan` rejects unknown tools, undeclared permissions, bad references and loops. |
| Tools | `src/lib/agent/tools.ts` | The registry and `runTool` (permission check -> input validation -> run -> output validation -> independent verify). |
| Executor | `src/lib/agent/executor.ts` | Create, approve, reject, run, review, edit, record, skip, retry. The only code that runs steps. |
| Job / recipe logic | `job.ts`, `recipe.ts` | Pure, deterministic: compare with CV, draft from CV lines, parse recipe, shopping list. |
| Reminders | `src/lib/reminders.ts` | Lifecycle of reminders. |

## Intent mapping
| What you might want | Intent kind | Workflow |
|---|---|---|
| Apply for a job | pursue (job) | job_application |
| Cook / save a recipe | try, do_later, remember (recipe) | recipe |
| Buy later | buy | followup |
| Attend an event | attend | followup |
| Reconnect with someone | reconnect | followup (drafts a message you send yourself) |
| Learn a concept | learn | followup, run as a **learning plan**: a study pack (`study.ts`: session plan, revision notes, flashcards, practice questions, exercises, all assembled from the memory's own facts and quotes, no model call), a revision reminder you date yourself, and your own "what I learned" step. Progress (cards known / to review, questions answered, exercises done) is saved on the plan and never alters the pack. |
| Finish something before a deadline | do_later (+ a stated deadline) | followup (reminder from the real deadline) |
| Follow up on an opportunity, recruiter, event or commitment | follow_up | followup (drafts a message you send yourself; reminder date is yours) |

## Guarantees (each is covered by a test)
1. No plan without a confirmed intent; a dismissed guess yields none.
2. Creating a plan runs nothing; nothing runs before approval; approval grants only the listed permissions.
3. A step needs its tool's permissions both declared on the step and approved on the plan.
4. A tool can only reach memories in its plan and the signed-in user's own data (RLS underneath).
5. A step is "done" only if the tool's separate verification passed; completion of the action requires every tool step verified and your evidence (>= 10 characters) for steps that are yours.
6. A plan's action can't be approved, cancelled or completed through the actions API.
7. Failures are recorded on the step (clear, safe message); the plan shows "Needs attention"; retry is limited to 5 attempts; interrupted steps are failed after 2 minutes so they can be retried.
8. Drafts contain only your CV's own lines; gaps stay gaps; years of experience are flagged for you to check; edits are marked as yours.
9. Dates are never invented: reminders derive from a deadline or date the item states, otherwise you choose.

## Not done / limits
- Drafts are deterministic assemblies, not model-written prose. A model-polished version could be added later: `claimProblems` in `draft.ts` is the gate it would have to pass (every claim needs real evidence, a requirement of this job, and no number the CV lacks).
- Plans exist only in templates; model-proposed plans are not accepted (the validator is ready for them).
- CV files: text-based PDFs, .docx and .txt only. Scanned PDFs (no OCR), password-protected PDFs, legacy .doc, and PDFs with unusual fonts are refused or may read poorly; paste the text instead. The PDF reader is a small built-in one, tested on Word-, Quartz- and groff-style PDFs, not on every producer.
- Reminders are shown in the app; no email, push or phone notification. Phone calling is out of scope.
- Matching is wording plus a short list of documented equivalents (React/ReactJS, A/B/split testing, ...) and related terms; paraphrases beyond that show as MISSING unless the optional embedding comparison is on, which can only produce POTENTIAL matches. Years of experience are the length of the dated role the evidence sits under, not time spent on a skill; year-only dates give a range and are never verified when the range could fall short.
- The plans, CV and follow-up migrations (`20261102000000`, `20261103000000`, `20261103010000`) have not been applied to your Supabase project: see `docs/phase4-migration.md`.
