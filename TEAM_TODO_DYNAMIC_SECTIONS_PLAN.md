# Team To-Do Tool — Dynamic Sections (Option C)

**Status: Implemented.** New sections are created only after the agent lists existing sections and the user confirms.

## Goal

Allow the team to-do list to support **new sections when another person joins the team** without requiring a code change. Today, sections are a fixed enum (`me`, `account_development_reps`, etc.); the doc must already have the matching Heading 2. This enhancement lets the agent create a new section (Heading 2) in the doc when the user adds a to-do for a new team member or role.

---

## Options

| Approach | Description | Pros | Cons |
|----------|-------------|------|------|
| **A. Optional `sectionLabel` in addTeamTodo** | Add optional `sectionLabel` (free text). If provided and no Heading 2 with that text exists, create it (e.g. append at end of body), then insert the to-do. If `section` (enum) is provided, behavior stays as today. | One tool; backward compatible; natural for "add to-do for Jane" → create "Jane" section if missing. | Need a rule: when to use enum vs free text (e.g. prefer enum when it matches, else sectionLabel). |
| **B. Dedicated createTeamTodoSection tool** | New tool `createTeamTodoSection(sectionLabel, fileId?)` that appends a Heading 2 (and optionally "SectionLabel — Done") to the doc. User or agent calls it when someone new joins; then addTeamTodo uses that section. | Clear separation; doc structure under user/agent control. | Two steps: create section, then add to-dos. Agent must know to create section first for new names. |
| **C. Hybrid** | Support both: (1) `section` enum as today; (2) optional `sectionLabel` in addTeamTodo that creates the heading if missing; (3) optional `createTeamTodoSection` for explicit "add a section for Jane" without adding a to-do yet. | Maximum flexibility; backward compatible. | Slightly more to document and implement. |

**Recommendation:** **Option A or C.** Prefer **A** for minimal surface: extend `addTeamTodo` only. Use **C** if you want an explicit "add a new section" action (e.g. "Add a section for Jane Smith to the team to-do doc").

---

## Scope (Option A — extend addTeamTodo only)

- **addTeamTodo**
  - **Current:** `section` (required, enum), `taskText` (required), `fileId` (optional).
  - **New:** Allow either:
    - `section` (enum) as today — use existing Heading 2 from `TEAM_TODO_SECTION_HEADINGS`.
    - **Or** `sectionLabel` (string, optional): free-text section name (e.g. "Jane Smith", "Contractor — Alex"). If `sectionLabel` is provided:
      - Resolve heading text = trimmed `sectionLabel`.
      - Look for existing Heading 2 with that exact text.
      - If not found, **create** it by appending at the end of the body: one paragraph with that text, set as HEADING2, then insert the to-do paragraph after it (so the new section contains the new task).
    - Rule: if both `section` and `sectionLabel` are provided, prefer `sectionLabel` (dynamic wins). If only `section`, behavior unchanged.
  - **markTeamTodoDone:** Accept optional `sectionLabel` in the same way: if provided, resolve section by that heading text; if not found, return a clear error (don’t create a section when marking done). This allows marking done in dynamically created sections.
- **Backward compatibility:** All existing calls with only `section` (enum) behave exactly as today. No change to `markTeamTodoDone` required for enum-only use.

---

## Scope (Option C — implemented with confirm-before-create)

- **listTeamTodoSections(fileId?)**
  - Returns `{ sections: string[] }` — all Heading 2 text in the doc that are **not** "— Done" blocks (main sections only). The agent calls this before creating a new section so it can list existing sections to the user and ask whether to add to one of those or create a new section.
- **createTeamTodoSection(sectionLabel, fileId?)**
  - Appends a Heading 2 with text = `sectionLabel` at the end of the body. **Only call after the user has confirmed** they want a new section. If the section already exists, returns an error.
- **addTeamTodo**
  - Accepts either `section` (enum) or `sectionLabel` (custom section). **Does not create** new sections: if `sectionLabel` is used and that Heading 2 does not exist, returns an error telling the agent to call listTeamTodoSections, ask the user, then createTeamTodoSection after confirmation and retry addTeamTodo.
- **markTeamTodoDone**
  - Accepts optional `sectionLabel`; resolves section by heading text (no create).
- **Agent flow:** When the user wants to add a to-do for a person/role that might be a new section, the agent (1) calls **listTeamTodoSections**, (2) lists the existing sections to the user and asks whether to add to one of those or create a new section, (3) only when the user confirms creating a new section, calls **createTeamTodoSection(sectionLabel)** then **addTeamTodo(sectionLabel, taskText)**. Never call createTeamTodoSection without confirming first.

---

## Doc structure with dynamic sections

- **Existing sections:** Unchanged (Me, Account Development Reps, etc.).
- **New sections:** Appended at the end of the document when created via `sectionLabel` or `createTeamTodoSection`. Each new section is a Heading 2; "SectionLabel — Done" can be created when the first item is marked done (reuse current markTeamTodoDone logic: find or create "X — Done" when moving an item).
- **Ordering:** Fixed-enum sections typically stay at the top (user maintains doc order); dynamic sections appear in creation order at the end unless the user reorders manually.

---

## Implementation outline (Option A)

1. **Code.js — addTeamTodo**
   - If `args.sectionLabel` is present and non-empty after trim:
     - Use `sectionHeading = args.sectionLabel.trim()`.
     - If `findTeamTodoHeading2Index(body, sectionHeading) === -1`, append: `body.appendParagraph(sectionHeading).setHeading(DocumentApp.ParagraphHeading.HEADING2)`, then `body.appendParagraph('☐ ' + taskText)` (task is the first item under the new heading). Return success.
     - Else (heading exists): get index, insert paragraph after it as today.
   - Else: keep current logic (require `section` enum, use `TEAM_TODO_SECTION_HEADINGS`).
   - Normalize: if only `section` provided, require known enum; if only `sectionLabel` or both, use sectionLabel for heading text (and create if missing when adding).
2. **Code.js — markTeamTodoDone**
   - If `args.sectionLabel` is present and non-empty: use it as heading text to find the section (do not create). If not found, return error.
   - Else: keep current logic (require `section` enum).
3. **Tool definitions**
   - addTeamTodo: add optional `sectionLabel` (string). Description: "Optional. Use for a custom section (e.g. new team member). If the Heading 2 does not exist, it will be created at the end of the doc. If both section and sectionLabel are provided, sectionLabel is used."
   - markTeamTodoDone: add optional `sectionLabel` (string). Description: "Optional. Use when the to-do is in a section created with sectionLabel (custom section name)."
4. **System prompts**
   - Update API/system prompts: when the user adds a to-do for a new person or custom role not in the fixed list, use addTeamTodo with sectionLabel set to that person/role name; the section will be created if needed.
5. **PROJECT.md**
   - Document optional `sectionLabel` for addTeamTodo and markTeamTodoDone; note that new sections are created at the end of the doc.

---

## Implementation outline (Option C — implemented)

- **listTeamTodoSections:** Implemented; helper `getTeamTodoMainSections(body)` returns Heading 2 text excluding " — Done" blocks.
- **createTeamTodoSection:** Implemented; appends one Heading 2 at end; errors if section already exists.
- **addTeamTodo:** Extended with optional `sectionLabel`. Requires either `section` or `sectionLabel`. Does **not** auto-create; if section missing, returns error instructing agent to list sections, ask user, then create after confirm.
- **markTeamTodoDone:** Extended with optional `sectionLabel`; resolves by heading text.
- **System prompts:** Updated so that before creating a new section the agent must call listTeamTodoSections, list existing sections to the user, and ask; only on user confirmation call createTeamTodoSection then addTeamTodo. Never call createTeamTodoSection without confirming first.
- **PROJECT.md:** Updated with all four tools and the confirm-before-create flow.

---

## Summary

- **Implemented (Option C with confirm-before-create):** listTeamTodoSections, createTeamTodoSection, addTeamTodo(section | sectionLabel), markTeamTodoDone(section | sectionLabel). New sections are created only after the agent lists existing sections and the user confirms.
- **Doc behavior:** New sections are appended at the end; "SectionLabel — Done" is created on first mark-done for that section. Fixed enum sections remain supported and unchanged.
