/**
 * CONFIGURATION
 * Use Script Properties for all deployment-time secrets/IDs.
 */
const DEFAULT_NOTES_ROOT_FOLDER_ID = '';
const GWSMCP_PENDING_PREFIX = 'GWSMCP_PENDING_';

function getAppConfig() {
  var props = PropertiesService.getScriptProperties();
  return {
    azureApiKey: (props.getProperty('AZURE_API_KEY') || '').trim(),
    azureEndpoint: (props.getProperty('AZURE_ENDPOINT') || '').trim(),
    templateId: (props.getProperty('TEMPLATE_ID') || '').trim(),
    notesRootFolderId: (props.getProperty('NOTES_ROOT_FOLDER_ID') || '').trim()
  };
}


/**
 * Run this function once from the Apps Script editor to trigger the OAuth consent screen
 * for all scopes (Calendar, Gmail, Drive, external HTTP). Select "requestAllScopes" in the
 * function dropdown and click Run; when prompted, approve all permissions. After that,
 * the time-driven trigger and other flows will have the access they need.
 */
function requestAllScopes() {
  CalendarApp.getDefaultCalendar().getName();
  GmailApp.getInboxThreads(0, 1).length;
  DriveApp.getRootFolder().getName();
  UrlFetchApp.fetch('https://www.google.com', { muteHttpExceptions: true });
  Logger.log('All scope checks completed. If you were prompted to authorize, you are set.');
}

/**
 * Returns the root folder ID for account/opp notes. Reads NOTES_ROOT_FOLDER_ID from
 * Script Properties; falls back to DEFAULT_NOTES_ROOT_FOLDER_ID if unset.
 * @returns {string}
 */
function getNotesRootFolderId() {
  const cfg = getAppConfig();
  return cfg.notesRootFolderId || DEFAULT_NOTES_ROOT_FOLDER_ID;
}

/** Section enum for team to-do list → Heading 2 text in the Doc. */
var TEAM_TODO_SECTION_HEADINGS = {
  me: 'Me',
  account_development_reps: 'Account Development Reps',
  solutions_architects: 'Solutions Architects',
  scaled_solutions_architects: 'Scaled Solution Architects',
  specialists: 'Specialists'
};

/**
 * Returns the default team to-do Doc ID from Script Property TEAM_TODO_DOC_ID.
 * @returns {string|null} File ID or null if unset.
 */
function getTeamTodoDocId() {
  const id = PropertiesService.getScriptProperties().getProperty('TEAM_TODO_DOC_ID');
  return (id && id.trim()) ? id.trim() : null;
}

/**
 * 1. THE WEB APP ENTRY POINT (MCP Gateway)
 * Payload: { "prompt": "..." } for single-turn API, or { "action": "chat", "messages": [...], "emailContext?: {...}", "apiKey?: "..." } for Chrome extension chat.
 */
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);

    // Chrome extension chat endpoint: full conversation + optional email context
    if (body.action === "chat") {
      const expectedKey = PropertiesService.getScriptProperties().getProperty("CHROME_EXTENSION_API_KEY");
      if (expectedKey && expectedKey.trim()) {
        const providedKey = body.apiKey || (body.apiKey === "" ? "" : null);
        if (providedKey !== expectedKey.trim()) {
          return createResponse({ error: "Unauthorized", reply: null }, 401);
        }
      }
      let messages = Array.isArray(body.messages) ? body.messages : [];
      if (body.emailContext && typeof body.emailContext === "object") {
        const ctx = body.emailContext;
        const parts = [];
        if (ctx.subject) parts.push("Subject: " + ctx.subject);
        if (ctx.from) parts.push("From: " + ctx.from);
        if (ctx.to) parts.push("To: " + ctx.to);
        if (ctx.date) parts.push("Date: " + ctx.date);
        if (ctx.snippetOrBody || ctx.body) parts.push("Body: " + (ctx.snippetOrBody || ctx.body));
        const contextBlock = "Current email I'm looking at:\n" + parts.join("\n");
        if (messages.length > 0 && messages[0].role === "user") {
          messages[0] = { role: "user", content: contextBlock + "\n\n" + (messages[0].content || "") };
        } else {
          messages = [{ role: "user", content: contextBlock }].concat(messages);
        }
      }
      var result;
      try {
        // Authorized by API key (or key not required); skip email allowlist check
        result = chatWithMCP(messages, true);
      } catch (chatErr) {
        Logger.log('[chat] chatWithMCP threw: ' + chatErr.toString());
        return createResponse({
          reply: 'Server error: ' + chatErr.toString(),
          error: chatErr.toString(),
          finalResult: undefined
        });
      }
      var replyText = (result && result.reply != null && result.reply !== '') ? result.reply : null;
      if (replyText == null) {
        Logger.log('[chat] chatWithMCP returned no reply. result=' + JSON.stringify(result));
        replyText = 'Server returned no reply. Check Apps Script Executions for logs.';
      }
      return createResponse({ reply: replyText, finalResult: result.finalResult || undefined });
    }

    // Legacy single-turn prompt API
    const userPrompt = body.prompt;
    if (userPrompt == null || typeof userPrompt !== "string") {
      return createResponse({ error: "Missing or invalid prompt" }, 400);
    }
    let messages = [
      { role: "system", content: "You are a Google Workspace orchestrator. You help users create 'New Workload' presentations and add email/meeting notes to Drive. For workload decks: use search tools, then createNewWorkloadPresentation. When the user only wants to find notes or get a link (e.g. 'look for notes in X folder', 'give me the link'), use getNotesRootFolderId, resolveNotesLocation with accountName and optionally oppName or workloadName, then findNotesInFolder(folderId); do not use getOrCreateNotesDoc. You can add or search notes in (1) account folder, (2) Account > Opps > [Opp] > Notes, or (3) Account > Workloads > [Workload]. For saving notes: use getNotesRootFolderId, extract account and optionally opportunity or workload, and only the meeting/information notes; call resolveNotesLocation (with oppName or workloadName if applicable), getOrCreateNotesDoc. appendNotesToDoc prepends by default (optionally set headingTitle, e.g. 'Meeting notes'); for opp or workload pass prepend: false to append. Format notes with ##, ###, - or * for structure and **bold**/ *italic* for emphasis so formatting is preserved. Ask first: only call appendNotesToDoc after the user has confirmed, unless the user's message already grants permission (e.g. 'add these notes', 'yes add them', 'go ahead'). If you need to ask, reply asking and do not append yet. When the user wants to create a new workload folder or set up a workload with its own notes: call getNotesRootFolderId, then resolveWorkloadFolderWithSuggestions; if match is 'none', tell the user the proposed folder name and path and list existingWorkloads, then only after they confirm call ensureWorkloadFolderAndNotes. Never create without confirming first. When the user asks to list all workloads for an account (e.g. 'list all the workload for an account', 'show workloads for X'), use getNotesRootFolderId then listWorkloadsForAccount(rootFolderId, accountName). When the user wants to view to-dos (e.g. 'show my to-dos', 'what do I have to do', 'list to-dos') without specifying a section, call listAllTeamTodosOpen immediately—do not ask which section. Only call listTeamTodoOpen when the user explicitly asks about a specific section. When the user wants to add a team to-do or mark one done, use addTeamTodo or markTeamTodoDone. For built-in roles use section (me, account_development_reps, solutions_architects, scaled_solutions_architects, specialists); for a custom section (e.g. new team member) use sectionLabel. Before creating a new section: call listTeamTodoSections, list the existing sections to the user, and ask whether to add the to-do to one of those or create a new section. Only when the user confirms they want a new section, call createTeamTodoSection(sectionLabel) then addTeamTodo(sectionLabel, taskText). Never call createTeamTodoSection without confirming first. When markTeamTodoDone returns needsConfirmation (no exact match), ask the user 'Did you mean: [suggestedTaskText]?' and list availableTodos; on confirmation call markTeamTodoDone again with taskText set to suggestedTaskText. After any successful mark done, list remainingTodos as additional options. Never ask the user for a fileId or TEAM_TODO_DOC_ID proactively; just call the tool and only if it returns an error about the doc ID, explain that TEAM_TODO_DOC_ID needs to be set in Script Properties." },
      { role: "user", content: userPrompt }
    ];

    let iterations = 0;
    const MAX_ITERATIONS = 10;

    while (iterations < MAX_ITERATIONS) {
      iterations++;
      const response = callAzure(messages);
      const assistantMessage = response.choices[0].message;
      messages.push(assistantMessage);

      if (assistantMessage.tool_calls) {
        assistantMessage.tool_calls.forEach(toolCall => {
          const functionName = toolCall.function.name;
          const args = JSON.parse(toolCall.function.arguments);
          
          let result;
          try {
            // EXECUTION: Dynamically call the script functions
            result = this[functionName](args);
          } catch (err) {
            result = "Error: " + err.toString();
          }

          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            name: functionName,
            content: JSON.stringify(result)
          });
        });
        continue;
      } else {
        return createResponse({ status: "complete", final_answer: assistantMessage.content });
      }
    }
  } catch (err) {
    return createResponse({ error: err.toString() }, 500);
  }
}

/**
 * 2. AZURE API CALLER
 * Normalizes messages so no message has null/undefined content (Azure expects a string).
 */
function callAzure(messages) {
  const cfg = getAppConfig();
  if (!cfg.azureApiKey || !cfg.azureEndpoint) {
    throw new Error('Missing Script Properties: AZURE_API_KEY and AZURE_ENDPOINT are required.');
  }
  var normalized = (messages || []).map(function(m) {
    var out = { role: m.role, content: m.content == null ? '' : (typeof m.content === 'string' ? m.content : String(m.content)) };
    if (m.tool_calls) out.tool_calls = m.tool_calls;
    if (m.tool_call_id != null) out.tool_call_id = m.tool_call_id;
    if (m.name != null) out.name = m.name;
    return out;
  });
  const payload = {
    messages: normalized,
    tools: getToolDefinitions(),
    tool_choice: "auto"
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: { 'api-key': cfg.azureApiKey },
    payload: JSON.stringify(payload)
  };

  return JSON.parse(UrlFetchApp.fetch(cfg.azureEndpoint, options).getContentText());
}

/**
 * 3. TOOL DEFINITIONS (What Azure knows it can do)
 */
function getToolDefinitions() {
  return [
    {
      type: "function",
      function: {
        name: "findFileByName",
        description: "Finds a Google Drive file by name to get its ID.",
        parameters: {
          type: "object",
          properties: { fileName: { type: "string" } },
          required: ["fileName"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "readDocContent",
        description: "Reads content from a Google Doc to gather workload notes.",
        parameters: {
          type: "object",
          properties: { fileId: { type: "string" } },
          required: ["fileId"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "createNewWorkloadPresentation",
        description: "Copies the Telco NBM template and populates all <TAGS> based on notes.",
        parameters: {
          type: "object",
          properties: {
            workloadName: { type: "string" },
            client: { type: "string" },
            notes: { type: "string", description: "The content for <DESCRIPTION>" },
            timeline: { type: "string", description: "The timeline for next steps" },
            corporateObjectives: { type: "string" },
            businessStrategy: { type: "string" },
            itInitiatives: { type: "string" },
            challenges: { type: "string" },
            requiredCapabilities: { type: "string" },
            currentSolution: { type: "string" },
            futureState: { type: "string" }
          },
          required: ["workloadName", "client", "notes"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "addCalendarReminder",
        description: "Adds a reminder (calendar event) to the user's default Google Calendar, or to a specific calendar if they ask (e.g. 'add to my Reminders calendar'). Use calendarName for a named calendar they own (e.g. 'Reminders'), or calendarId if they specify an ID. Use the email or conversation context to set title and description when the user asks for a reminder from an email or with context. For startTime, resolve relative or vague times (e.g. 'late tomorrow afternoon' → ~2pm tomorrow, 'next Tuesday morning' → 9am that day) to a concrete date and time in ISO 8601 format (YYYY-MM-DDTHH:mm or YYYY-MM-DDTHH:mm:ss). Returns when the reminder was added, which calendar was used, and a confirmation message.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "Short title for the reminder; derive from email/context when relevant." },
            description: { type: "string", description: "Longer context (e.g. email snippet)." },
            startTime: { type: "string", description: "Start date/time in ISO 8601 form (e.g. 2025-02-22T14:00:00). Resolve natural language (e.g. 'late tomorrow afternoon', 'next Monday 9am') to this format before calling." },
            durationMinutes: { type: "number", description: "Event length in minutes; default 15." },
            calendarName: { type: "string", description: "Exact name of a calendar the user owns (e.g. 'Reminders', 'MCP Reminders'). Use when the user asks to add to a specific calendar that isn't their main one." },
            calendarId: { type: "string", description: "Calendar ID (from Calendar settings). If provided, overrides calendarName and default." }
          },
          required: ["title", "startTime"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "getNotesRootFolderId",
        description: "Returns the root folder ID for account and opportunity notes in Drive. Call this first when listing workloads for an account or when resolving note locations (e.g. to pass rootFolderId to resolveNotesLocation or listWorkloadsForAccount).",
        parameters: { type: "object", properties: {}, required: [] }
      }
    },
    {
      type: "function",
      function: {
        name: "listSubfolders",
        description: "List direct subfolders of a Drive folder by ID. Returns { subfolders: [{ name, id }] }. Use for matching account or opportunity names, or to navigate folder structure. When the user asks to list all workloads for an account, use getNotesRootFolderId then listWorkloadsForAccount instead.",
        parameters: {
          type: "object",
          properties: { folderId: { type: "string" } },
          required: ["folderId"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "resolveNotesLocation",
        description: "Find where notes should go: account folder, Opps > [Opp] > Notes, or Workloads > [Workload]. Given root folder ID and account name; optionally oppName (Account > Opps > [Opp] > Notes) or workloadName (Account > Workloads > [Workload]). If both oppName and workloadName are provided, oppName takes precedence. Returns notesFolderId and pathDescription.",
        parameters: {
          type: "object",
          properties: {
            rootFolderId: { type: "string" },
            accountName: { type: "string" },
            oppName: { type: "string", description: "Optional opportunity name; if set, looks for Account > Opps > [Opp folder] > Notes." },
            workloadName: { type: "string", description: "Optional workload name; if set (and no oppName), looks for Account > Workloads > [Workload folder]." }
          },
          required: ["rootFolderId", "accountName"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "getOrCreateNotesDoc",
        description: "In a given folder, find an existing notes doc (any name containing 'notes', e.g. 'Ongoing notes', 'Account Notes'); create one named preferredName or 'Notes' if none found. Returns { fileId, url }.",
        parameters: {
          type: "object",
          properties: {
            folderId: { type: "string" },
            preferredName: { type: "string", description: "Optional doc name to look for or use when creating." }
          },
          required: ["folderId"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "findNotesInFolder",
        description: "Read-only: list notes docs in a folder. Matches any doc whose name contains 'notes' (e.g. 'Notes', 'Account Notes', 'Ongoing notes'). Returns { docs: [{ name, fileId, url }] } or { docs: [] }. Use when the user only wants to find notes or get a link; does not create. Use getNotesRootFolderId, resolveNotesLocation(accountName, oppName?, workloadName?), then findNotesInFolder(folderId) for account, opp, or workload.",
        parameters: {
          type: "object",
          properties: {
            folderId: { type: "string" },
            preferredName: { type: "string", description: "Optional doc name to look for." }
          },
          required: ["folderId"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "appendNotesToDoc",
        description: "Add notes to a Google Doc. Prepend defaults to true: insert at beginning with Heading 2 (headingTitle, or 'Notes' if omitted) and Heading 3 (date). For opp or workload, pass prepend: false to append at end with optional sourceLabel. When the document uses Google Docs tabs, content is inserted into the first tab unless tabId or tabTitle is provided. Use tabTitle (e.g. 'Meeting notes') to target a tab by name, or tabId to target by ID (from the doc URL). To preserve structure and emphasis, format notesText with markdown-lite: ##, ###, - or * for bullets, **bold** / *italic*.",
        parameters: {
          type: "object",
          properties: {
            fileId: { type: "string" },
            notesText: { type: "string" },
            sourceLabel: { type: "string", description: "Optional label for the section when appending (e.g. 'from email'). Used when prepend is false." },
            prepend: { type: "boolean", description: "Defaults to true (prepend with H2/H3). Set to false for opp or workload to append at end." },
            headingTitle: { type: "string", description: "When prepending, use as Heading 2 title (e.g. 'Meeting notes'). Defaults to 'Notes' if omitted." },
            tabId: { type: "string", description: "Optional. When the doc has Google Docs tabs, use this to insert into a specific tab by ID (from the tab URL)." },
            tabTitle: { type: "string", description: "Optional. When the doc has tabs, use this to insert into the tab whose title matches (e.g. 'Meeting notes'). Case-insensitive match." }
          },
          required: ["fileId", "notesText"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "storePendingNotesConfirmation",
        description: "Store pending notes for this email thread so a follow-up 'yes' can trigger append. Use when asking for confirmation instead of appending immediately. Requires threadId from the prompt context. Include prepend and headingTitle when the target is the account folder. If the doc has tabs, include tabId or tabTitle so the confirm step inserts into the right tab.",
        parameters: {
          type: "object",
          properties: {
            threadId: { type: "string" },
            fileId: { type: "string" },
            notesText: { type: "string" },
            sourceLabel: { type: "string" },
            pathDescription: { type: "string" },
            prepend: { type: "boolean", description: "Optional; set true for account folder so appendNotesToDoc will prepend with H2/H3 on confirm." },
            headingTitle: { type: "string", description: "Optional; when prepend is true, descriptive title for the new section (e.g. 'Meeting notes')." },
            tabId: { type: "string", description: "Optional; when the doc has tabs, tab ID to use on confirm." },
            tabTitle: { type: "string", description: "Optional; when the doc has tabs, tab title to use on confirm (e.g. 'Meeting notes')." }
          },
          required: ["threadId", "fileId", "notesText", "sourceLabel", "pathDescription"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "getPendingNotesForThread",
        description: "Return stored pending notes for this thread, if any. If the user's message is a confirmation (e.g. 'yes'), use this then call appendNotesToDoc and clearPendingNotes.",
        parameters: {
          type: "object",
          properties: { threadId: { type: "string" } },
          required: ["threadId"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "clearPendingNotes",
        description: "Remove stored pending notes for this thread after successfully appending.",
        parameters: {
          type: "object",
          properties: { threadId: { type: "string" } },
          required: ["threadId"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "resolveWorkloadFolderWithSuggestions",
        description: "Resolve where a workload folder is or would be. Uses fuzzy search for account; for workload, a 90% string-similarity match is treated as confident. Does not create anything. Returns either a confident match (notesFolderId, pathDescription) or no match with proposedPath and existingWorkloads (list of { name, id }) so the user can confirm creating a new folder or adding to an existing one. Call getNotesRootFolderId first to get rootFolderId. For listing all workloads for an account (without a specific workload name), use listWorkloadsForAccount.",
        parameters: {
          type: "object",
          properties: {
            rootFolderId: { type: "string" },
            accountName: { type: "string" },
            workloadName: { type: "string" }
          },
          required: ["rootFolderId", "accountName", "workloadName"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "listWorkloadsForAccount",
        description: "List all workload folders for an account (under Account > Workloads). Use when the user asks to list, show, or enumerate all workloads for an account (e.g. 'list all of the workload for an account', 'list all workloads in a folder for an account', 'what workloads does X have?'). Returns workloads as array of { name, id }. Call getNotesRootFolderId first to get rootFolderId.",
        parameters: {
          type: "object",
          properties: {
            rootFolderId: { type: "string" },
            accountName: { type: "string" }
          },
          required: ["rootFolderId", "accountName"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "ensureWorkloadFolderAndNotes",
        description: "Create the folder path Account > Workloads > [Workload] under the notes root if it does not exist, then find or create a notes document in that workload folder. Only call after the user has confirmed the folder name and location. Call getNotesRootFolderId first.",
        parameters: {
          type: "object",
          properties: {
            rootFolderId: { type: "string" },
            accountName: { type: "string" },
            workloadName: { type: "string" },
            preferredNotesName: { type: "string", description: "Optional name for the notes doc when creating." }
          },
          required: ["rootFolderId", "accountName", "workloadName"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "addTeamTodo",
        description: "Add a to-do item to the team to-do Google Doc under a specific section. Use section (enum) for built-in roles, or sectionLabel for a custom section (e.g. created with createTeamTodoSection). If sectionLabel is used and that section does not exist, the tool returns an error: call listTeamTodoSections to show existing sections, ask the user to add to one of those or create a new section, and only after they confirm call createTeamTodoSection then addTeamTodo. Uses default doc from TEAM_TODO_DOC_ID unless fileId is provided.",
        parameters: {
          type: "object",
          properties: {
            section: { type: "string", description: "One of: me, account_development_reps, solutions_architects, scaled_solutions_architects, specialists. Use for built-in roles." },
            sectionLabel: { type: "string", description: "Optional. Custom section name (e.g. new team member). Section must already exist (create with createTeamTodoSection first after user confirms)." },
            taskText: { type: "string", description: "The to-do task text." },
            fileId: { type: "string", description: "Optional. Override the default team to-do doc (from TEAM_TODO_DOC_ID)." }
          },
          required: ["taskText"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "markTeamTodoDone",
        description: "Mark a team to-do as done by moving it to the section's Done block. Finds the paragraph containing taskText within the given section, removes it, and appends it under the '[Role] — Done' Heading 2 (e.g. 'Me — Done'), creating that block if missing. Use section (enum) or sectionLabel (for custom sections). If no exact match: returns needsConfirmation, suggestedTaskText, and availableTodos—ask the user 'Did you mean: [suggestedTaskText]?' and list availableTodos; on confirmation call again with taskText set to suggestedTaskText. On success, the response includes remainingTodos—always list them afterwards as additional options for the user. Uses default doc from TEAM_TODO_DOC_ID unless fileId is provided.",
        parameters: {
          type: "object",
          properties: {
            section: { type: "string", description: "One of: me, account_development_reps, solutions_architects, scaled_solutions_architects, specialists. Use when section is a built-in role." },
            sectionLabel: { type: "string", description: "Optional. Custom section name (e.g. new team member). Use when the to-do is in a section created with createTeamTodoSection." },
            taskText: { type: "string", description: "Text that identifies the to-do paragraph to mark done (match by containing this text)." },
            fileId: { type: "string", description: "Optional. Override the default team to-do doc." }
          },
          required: ["taskText"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "listTeamTodoSections",
        description: "List existing section names (Heading 2) in the team to-do doc, excluding '— Done' blocks. Use before creating a new section so you can show the user existing sections and ask whether to add to one of those or create a new section. Only call createTeamTodoSection after the user confirms they want a new section.",
        parameters: {
          type: "object",
          properties: {
            fileId: { type: "string", description: "Optional. Override the default team to-do doc." }
          },
          required: []
        }
      }
    },
    {
      type: "function",
      function: {
        name: "createTeamTodoSection",
        description: "Create a new section (Heading 2) at the end of the team to-do doc. Only call after the user has confirmed they want a new section (e.g. for a new team member). First call listTeamTodoSections and list those sections to the user; ask whether to add to an existing section or create a new one; only when they confirm creating a new section, call this tool then addTeamTodo with sectionLabel.",
        parameters: {
          type: "object",
          properties: {
            sectionLabel: { type: "string", description: "Name for the new section (e.g. person or role name)." },
            fileId: { type: "string", description: "Optional. Override the default team to-do doc." }
          },
          required: ["sectionLabel"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "listTeamTodoOpen",
        description: "List all open (non-done) to-dos under a specific section in the team to-do doc. Returns paragraph text for each item in that section (items in the section before the '— Done' block). Use section (enum) or sectionLabel for custom sections. If the user doesn't specify a section, use listAllTeamTodosOpen instead.",
        parameters: {
          type: "object",
          properties: {
            section: { type: "string", description: "One of: me, account_development_reps, solutions_architects, scaled_solutions_architects, specialists." },
            sectionLabel: { type: "string", description: "Optional. Custom section name (e.g. new team member)." },
            fileId: { type: "string", description: "Optional. Override the default team to-do doc." }
          },
          required: []
        }
      }
    },
    {
      type: "function",
      function: {
        name: "listAllTeamTodosOpen",
        description: "List all open (non-done) to-dos across every section in the team to-do doc. Returns { sections: [{ section, todos }] } for every Heading 2 that is not a Done block. Use this when the user asks to see their to-dos without specifying a particular section, or asks for 'all to-dos', 'my to-dos', 'what do I have to do', etc. Do not ask the user to specify a section first; just call this tool.",
        parameters: {
          type: "object",
          properties: {
            fileId: { type: "string", description: "Optional. Override the default team to-do doc." }
          },
          required: []
        }
      }
    },
    {
      type: "function",
      function: {
        name: "getWorkloadSheetData",
        description: "Reads a tab from a Google Sheets spreadsheet and returns a structured list of workloads. Each row is treated as one workload, identified by the opportunity name column. Returns all column values for each workload row. Use this when the user asks to see workloads from a CRM sheet or a specific Google Sheets tab. sheetId is optional if WORKLOAD_SHEET_ID is set in Script Properties.",
        parameters: {
          type: "object",
          properties: {
            sheetId: {
              type: "string",
              description: "The Google Sheets spreadsheet ID (from the URL). Optional if WORKLOAD_SHEET_ID is configured in Script Properties."
            },
            tabName: {
              type: "string",
              description: "The name of the tab/sheet within the spreadsheet to read."
            },
            opportunityNameColumn: {
              type: "string",
              description: "The header name of the column that contains opportunity/workload names. Defaults to 'Opportunity Name' if not specified."
            }
          },
          required: ["tabName"]
        }
      }
    }
  ];
}

/**
 * 4. ACTUAL SCRIPT FUNCTIONS (Tools)
 */

function findFileByName(args) {
  const files = DriveApp.getFilesByName(args.fileName);
  return files.hasNext() ? { id: files.next().getId() } : "File not found.";
}

function readDocContent(args) {
  return DocumentApp.openById(args.fileId).getBody().getText();
}

function createNewWorkloadPresentation(args) {
  const cfg = getAppConfig();
  if (!cfg.templateId) {
    throw new Error('Missing Script Property: TEMPLATE_ID is required.');
  }
  const folder = DriveApp.getRootFolder();
  const newFile = DriveApp.getFileById(cfg.templateId).makeCopy(`${args.client} - ${args.workloadName}`, folder);
  const presentationId = newFile.getId();
  
  // Mapping the LLM's parsed arguments to the exact bracket tags in your doc
  const replacements = {
    '<DESCRIPTION>': args.notes,
    '<WORKLOADNAME>': args.workloadName,
    '<CORPORATEOBJECTIVES>': args.corporateObjectives || "N/A",
    '<BUSINESSSTRAT>': args.businessStrategy || "N/A",
    '<ITINITIATIVES>': args.itInitiatives || "N/A",
    '<CHALLENGES>': args.challenges || "N/A",
    '<RCS>': args.requiredCapabilities || "N/A",
    '<CURRENTSOL>': args.currentSolution || "N/A",
    '<IDEALFUTURESTATE>': args.futureState || "N/A",
    '<Lay out your next steps with MongoDB’s role, the customer’s role, and agreed upon due dates.>': args.timeline || "TBD"
  };

  const presentation = SlidesApp.openById(presentationId);
  for (const [tag, value] of Object.entries(replacements)) {
    presentation.replaceAllText(tag, value || "Information not provided");
  }
  
  return { url: presentation.getUrl(), status: "Presentation Created Successfully" };
}

/**
 * Adds a reminder (short calendar event) to the user's default calendar or a named/ID calendar.
 * @param {Object} args - title, startTime (ISO 8601), optional description, durationMinutes, calendarName, calendarId
 * @returns {{ success: boolean, when?: string, calendarName?: string, title?: string, description?: string, message?: string, error?: string }}
 */
function addCalendarReminder(args) {
  try {
    const start = new Date(args.startTime);
    if (isNaN(start.getTime())) {
      return { success: false, error: "Invalid startTime: " + args.startTime };
    }
    const durationMinutes = args.durationMinutes != null ? args.durationMinutes : 15;
    const end = new Date(start.getTime() + durationMinutes * 60 * 1000);
    const title = (args.title || "").trim() || "Reminder";
    const description = (args.description || "").trim();

    let calendar = null;
    if (args.calendarId) {
      calendar = CalendarApp.getCalendarById(args.calendarId);
      if (!calendar) {
        return { success: false, error: "Calendar not found for ID: " + args.calendarId };
      }
    } else if (args.calendarName) {
      const owned = CalendarApp.getOwnedCalendarsByName(args.calendarName);
      if (!owned || owned.length === 0) {
        return { success: false, error: "No owned calendar named '" + args.calendarName + "' found." };
      }
      calendar = owned[0];
    } else {
      calendar = CalendarApp.getDefaultCalendar();
    }

    const event = calendar.createEvent(title, start, end, { description: description });
    event.addPopupReminder(15);

    const tz = Session.getScriptTimeZone();
    const whenStr = Utilities.formatDate(start, tz, "EEEE, MMM d, yyyy 'at' h:mm a");
    const calName = calendar.getName();
    return {
      success: true,
      when: whenStr,
      calendarName: calName,
      title: title,
      description: description,
      message: "Reminder added to " + calName + " for " + whenStr + "."
    };
  } catch (err) {
    return { success: false, error: err.message || err.toString() };
  }
}

/**
 * List direct subfolders of a Drive folder. Returns { subfolders: [{ name, id }] }.
 */
function listSubfolders(args) {
  try {
    const folder = DriveApp.getFolderById(args.folderId);
    const subfolders = [];
    const iter = folder.getFolders();
    while (iter.hasNext()) {
      const f = iter.next();
      subfolders.push({ name: f.getName(), id: f.getId() });
    }
    return { subfolders: subfolders };
  } catch (err) {
    return { error: err.message || err.toString() };
  }
}

/**
 * Find folder whose name best matches the given string (case-insensitive contains or equals).
 */
function findBestMatchingFolder(folders, searchName) {
  if (!searchName || !searchName.trim()) return null;
  const lower = searchName.trim().toLowerCase();
  let best = null;
  let bestScore = 0;
  for (let i = 0; i < folders.length; i++) {
    const name = folders[i].name;
    const lowerName = name.toLowerCase();
    if (lowerName === lower) return folders[i];
    if (lowerName.indexOf(lower) !== -1 || lower.indexOf(lowerName) !== -1) {
      const score = Math.min(name.length, searchName.length);
      if (score > bestScore) {
        bestScore = score;
        best = folders[i];
      }
    }
  }
  return best;
}

/** Levenshtein edit distance between two strings. */
function levenshteinDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = [];
  for (let i = 0; i <= m; i++) {
    dp[i] = [i];
  }
  for (let j = 0; j <= n; j++) {
    dp[0][j] = j;
  }
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

/**
 * String similarity score 0-1. Uses normalized Levenshtein distance.
 * Confident match threshold is 0.9 (90%).
 */
function stringSimilarity(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return 0;
  const sa = (a || '').trim().toLowerCase();
  const sb = (b || '').trim().toLowerCase();
  if (sa === sb) return 1;
  if (sa.length === 0 || sb.length === 0) return 0;
  const d = levenshteinDistance(sa, sb);
  const maxLen = Math.max(sa.length, sb.length);
  return 1 - d / maxLen;
}

/**
 * Resolve where notes should go: account folder, Account > Opps > [Opp] > Notes, or Account > Workloads > [Workload].
 * Returns { notesFolderId, pathDescription } or { error }.
 * oppName and workloadName are mutually exclusive; if both provided, oppName takes precedence.
 */
function resolveNotesLocation(args) {
  try {
    const rootId = args.rootFolderId;
    const accountName = (args.accountName || '').trim();
    const oppName = args.oppName ? (args.oppName + '').trim() : null;
    const workloadName = args.workloadName ? (args.workloadName + '').trim() : null;
    if (!accountName) {
      return { error: 'accountName is required.' };
    }
    const root = DriveApp.getFolderById(rootId);
    const rootSub = listSubfolders({ folderId: rootId });
    if (rootSub.error) return rootSub;
    const accountFolder = findBestMatchingFolder(rootSub.subfolders, accountName);
    if (!accountFolder) {
      return { error: 'No account folder matching "' + accountName + '" found. Available: ' + rootSub.subfolders.map(function(f) { return f.name; }).join(', ') };
    }
    if (oppName) {
      const accSub = listSubfolders({ folderId: accountFolder.id });
      if (accSub.error) return accSub;
      const oppsFolder = accSub.subfolders.find(function(f) { return f.name.toLowerCase() === 'opps'; });
      if (!oppsFolder) {
        return { error: 'Account folder has no "Opps" subfolder. Use account-level notes or create Opps.' };
      }
      const oppsSub = listSubfolders({ folderId: oppsFolder.id });
      if (oppsSub.error) return oppsSub;
      const oppFolder = findBestMatchingFolder(oppsSub.subfolders, oppName);
      if (!oppFolder) {
        return { error: 'No opportunity folder matching "' + oppName + '" under Opps. Available: ' + oppsSub.subfolders.map(function(f) { return f.name; }).join(', ') };
      }
      const oppSub = listSubfolders({ folderId: oppFolder.id });
      if (oppSub.error) return oppSub;
      const notesFolder = oppSub.subfolders.find(function(f) { return f.name.toLowerCase() === 'notes'; });
      if (!notesFolder) {
        return { error: 'Opportunity folder has no "Notes" subfolder. Create it or use account-level notes.' };
      }
      return {
        notesFolderId: notesFolder.id,
        pathDescription: 'Account: ' + accountFolder.name + ' > Opps > ' + oppFolder.name + ' > Notes'
      };
    }
    if (workloadName) {
      const accSub = listSubfolders({ folderId: accountFolder.id });
      if (accSub.error) return accSub;
      const workloadsFolder = accSub.subfolders.find(function(f) { return f.name.toLowerCase() === 'workloads'; });
      if (!workloadsFolder) {
        return { error: 'Account folder has no "Workloads" subfolder. Use account-level notes or create Workloads.' };
      }
      const workloadsSub = listSubfolders({ folderId: workloadsFolder.id });
      if (workloadsSub.error) return workloadsSub;
      const workloadFolder = findBestMatchingFolder(workloadsSub.subfolders, workloadName);
      if (!workloadFolder) {
        return { error: 'No workload folder matching "' + workloadName + '" under Workloads. Available: ' + workloadsSub.subfolders.map(function(f) { return f.name; }).join(', ') };
      }
      return {
        notesFolderId: workloadFolder.id,
        pathDescription: 'Account: ' + accountFolder.name + ' > Workloads > ' + workloadFolder.name
      };
    }
    return {
      notesFolderId: accountFolder.id,
      pathDescription: 'Account: ' + accountFolder.name
    };
  } catch (err) {
    return { error: err.message || err.toString() };
  }
}

/** Confident match threshold for workload folder name (90%). */
const WORKLOAD_MATCH_THRESHOLD = 0.9;

/**
 * Resolve workload folder with fuzzy search. Does not create anything.
 * Returns either a confident match (similarity >= 90%) or proposedPath + existingWorkloads.
 * @param {{ rootFolderId: string, accountName: string, workloadName: string }} args
 * @returns {{ match: string, notesFolderId?: string, pathDescription?: string, proposedPath?: string, existingWorkloads?: Array<{name: string, id: string}> } | { error: string }}
 */
function resolveWorkloadFolderWithSuggestions(args) {
  try {
    const rootId = (args.rootFolderId || '').trim();
    const accountName = (args.accountName || '').trim();
    const workloadName = (args.workloadName || '').trim();
    if (!rootId || !accountName || !workloadName) {
      return { error: 'rootFolderId, accountName, and workloadName are required.' };
    }
    const rootSub = listSubfolders({ folderId: rootId });
    if (rootSub.error) return rootSub;
    const accountFolder = findBestMatchingFolder(rootSub.subfolders, accountName);
    if (!accountFolder) {
      return { error: 'No account folder matching "' + accountName + '" found. Available: ' + rootSub.subfolders.map(function(f) { return f.name; }).join(', ') };
    }
    const accSub = listSubfolders({ folderId: accountFolder.id });
    if (accSub.error) return accSub;
    const workloadsFolder = accSub.subfolders.find(function(f) { return f.name.toLowerCase() === 'workloads'; });
    if (!workloadsFolder) {
      return {
        error: 'Account folder has no "Workloads" subfolder.',
        proposedPath: accountFolder.name + ' > Workloads > ' + workloadName,
        existingWorkloads: []
      };
    }
    const workloadsSub = listSubfolders({ folderId: workloadsFolder.id });
    if (workloadsSub.error) return workloadsSub;
    const searchLower = workloadName.toLowerCase();
    let bestFolder = null;
    let bestScore = 0;
    for (let i = 0; i < workloadsSub.subfolders.length; i++) {
      const f = workloadsSub.subfolders[i];
      const score = stringSimilarity(workloadName, f.name);
      if (score > bestScore) {
        bestScore = score;
        bestFolder = f;
      }
    }
    if (bestFolder && bestScore >= WORKLOAD_MATCH_THRESHOLD) {
      return {
        match: 'exact',
        notesFolderId: bestFolder.id,
        pathDescription: 'Account: ' + accountFolder.name + ' > Workloads > ' + bestFolder.name,
        existingWorkloads: workloadsSub.subfolders.map(function(f) { return { name: f.name, id: f.id }; })
      };
    }
    return {
      match: 'none',
      proposedPath: accountFolder.name + ' > Workloads > ' + workloadName,
      existingWorkloads: workloadsSub.subfolders.map(function(f) { return { name: f.name, id: f.id }; })
    };
  } catch (err) {
    return { error: err.message || err.toString() };
  }
}

/**
 * List all workload folders for an account (under Account > Workloads). Does not create anything.
 * @param {{ rootFolderId: string, accountName: string }} args
 * @returns {{ workloads: Array<{name: string, id: string}>, pathDescription?: string } | { error: string }}
 */
function listWorkloadsForAccount(args) {
  try {
    const rootId = (args.rootFolderId || '').trim();
    const accountName = (args.accountName || '').trim();
    if (!rootId || !accountName) {
      return { error: 'rootFolderId and accountName are required.' };
    }
    const rootSub = listSubfolders({ folderId: rootId });
    if (rootSub.error) return rootSub;
    const accountFolder = findBestMatchingFolder(rootSub.subfolders, accountName);
    if (!accountFolder) {
      return { error: 'No account folder matching "' + accountName + '" found. Available: ' + rootSub.subfolders.map(function(f) { return f.name; }).join(', ') };
    }
    const accSub = listSubfolders({ folderId: accountFolder.id });
    if (accSub.error) return accSub;
    const workloadsFolder = accSub.subfolders.find(function(f) { return f.name.toLowerCase() === 'workloads'; });
    if (!workloadsFolder) {
      return {
        error: 'Account folder has no "Workloads" subfolder.',
        workloads: [],
        pathDescription: 'Account: ' + accountFolder.name + ' > Workloads'
      };
    }
    const workloadsSub = listSubfolders({ folderId: workloadsFolder.id });
    if (workloadsSub.error) return workloadsSub;
    const pathDescription = 'Account: ' + accountFolder.name + ' > Workloads';
    return {
      workloads: workloadsSub.subfolders.map(function(f) { return { name: f.name, id: f.id }; }),
      pathDescription: pathDescription
    };
  } catch (err) {
    return { error: err.message || err.toString() };
  }
}

/**
 * Create the folder path Account > Workloads > [Workload] under the notes root if it does not exist,
 * then find or create a notes document in that workload folder. Call only after user has confirmed folder name and location.
 * @param {{ rootFolderId: string, accountName: string, workloadName: string, preferredNotesName?: string }} args
 * @returns {{ workloadFolderId: string, pathDescription: string, fileId: string, url: string } | { error: string }}
 */
function ensureWorkloadFolderAndNotes(args) {
  try {
    const rootId = (args.rootFolderId || '').trim();
    const accountName = (args.accountName || '').trim();
    const workloadName = (args.workloadName || '').trim();
    if (!rootId || !accountName || !workloadName) {
      return { error: 'rootFolderId, accountName, and workloadName are required.' };
    }
    const root = DriveApp.getFolderById(rootId);
    const rootSub = listSubfolders({ folderId: rootId });
    if (rootSub.error) return rootSub;
    let accountFolder = findBestMatchingFolder(rootSub.subfolders, accountName);
    if (!accountFolder) {
      accountFolder = { id: root.createFolder(accountName).getId(), name: accountName };
    } else {
      accountFolder = { id: accountFolder.id, name: accountFolder.name };
    }
    const accSub = listSubfolders({ folderId: accountFolder.id });
    if (accSub.error) return accSub;
    let workloadsFolder = accSub.subfolders.find(function(f) { return f.name.toLowerCase() === 'workloads'; });
    if (!workloadsFolder) {
      const newWls = DriveApp.getFolderById(accountFolder.id).createFolder('Workloads');
      workloadsFolder = { id: newWls.getId(), name: newWls.getName() };
    }
    const workloadsSub = listSubfolders({ folderId: workloadsFolder.id });
    if (workloadsSub.error) return workloadsSub;
    const workloadFolderMatch = findBestMatchingFolder(workloadsSub.subfolders, workloadName);
    let workloadFolder;
    if (workloadFolderMatch) {
      workloadFolder = { id: workloadFolderMatch.id, name: workloadFolderMatch.name };
    } else {
      const newWlf = DriveApp.getFolderById(workloadsFolder.id).createFolder(workloadName);
      workloadFolder = { id: newWlf.getId(), name: newWlf.getName() };
    }
    const pathDescription = 'Account: ' + accountFolder.name + ' > Workloads > ' + workloadFolder.name;
    const defaultNotesName = accountFolder.name + ' - ' + workloadFolder.name + ' Notes Document';
    const notesResult = getOrCreateNotesDoc({
      folderId: workloadFolder.id,
      preferredName: (args.preferredNotesName && (args.preferredNotesName + '').trim()) ? (args.preferredNotesName + '').trim() : defaultNotesName
    });
    if (notesResult.error) return notesResult;
    return {
      workloadFolderId: workloadFolder.id,
      pathDescription: pathDescription,
      fileId: notesResult.fileId,
      url: notesResult.url
    };
  } catch (err) {
    return { error: err.message || err.toString() };
  }
}

/**
 * Find the body child index of a paragraph that is Heading 2 with the given text (trimmed).
 * @param {GoogleAppsScript.Document.Body} body
 * @param {string} headingText
 * @returns {number} Child index or -1 if not found.
 */
function findTeamTodoHeading2Index(body, headingText) {
  const target = (headingText || '').trim();
  if (!target) return -1;
  const n = body.getNumChildren();
  for (let i = 0; i < n; i++) {
    const child = body.getChild(i);
    if (child.getType() !== DocumentApp.ElementType.PARAGRAPH) continue;
    const para = child.asParagraph();
    if (para.getHeading() === DocumentApp.ParagraphHeading.HEADING2 && para.getText().trim() === target) {
      return i;
    }
  }
  return -1;
}

/**
 * Return all Heading 2 text in the body that are not "— Done" blocks (main sections only).
 * @param {GoogleAppsScript.Document.Body} body
 * @returns {string[]}
 */
function getTeamTodoMainSections(body) {
  const sections = [];
  const n = body.getNumChildren();
  for (let i = 0; i < n; i++) {
    const child = body.getChild(i);
    if (child.getType() !== DocumentApp.ElementType.PARAGRAPH) continue;
    const para = child.asParagraph();
    if (para.getHeading() !== DocumentApp.ParagraphHeading.HEADING2) continue;
    const text = para.getText().trim();
    if (text && text.indexOf(' — Done') === -1) {
      sections.push(text);
    }
  }
  return sections;
}

/**
 * List existing section names (main sections only, excluding "— Done" blocks) in the team to-do doc.
 * @param {{ fileId?: string }} args
 * @returns {{ sections: string[] } | { error: string }}
 */
function listTeamTodoSections(args) {
  try {
    const docId = (args.fileId && (args.fileId + '').trim()) ? (args.fileId + '').trim() : getTeamTodoDocId();
    if (!docId) {
      return { error: 'Set TEAM_TODO_DOC_ID in Script Properties, or pass fileId.' };
    }
    const body = DocumentApp.openById(docId).getBody();
    const sections = getTeamTodoMainSections(body);
    return { sections: sections };
  } catch (err) {
    return { error: err.message || err.toString() };
  }
}

/**
 * Create a new section (Heading 2) at the end of the team to-do doc. Only call after user has confirmed.
 * @param {{ sectionLabel: string, fileId?: string }} args
 * @returns {{ success: boolean, message?: string, url?: string, sectionLabel?: string, error?: string }}
 */
function createTeamTodoSection(args) {
  try {
    const docId = (args.fileId && (args.fileId + '').trim()) ? (args.fileId + '').trim() : getTeamTodoDocId();
    if (!docId) {
      return { error: 'Set TEAM_TODO_DOC_ID in Script Properties, or pass fileId.' };
    }
    const sectionLabel = (args.sectionLabel || '').trim();
    if (!sectionLabel) {
      return { error: 'sectionLabel is required.' };
    }
    const doc = DocumentApp.openById(docId);
    const body = doc.getBody();
    if (findTeamTodoHeading2Index(body, sectionLabel) !== -1) {
      return { error: 'Section "' + sectionLabel + '" already exists.' };
    }
    body.appendParagraph(sectionLabel).setHeading(DocumentApp.ParagraphHeading.HEADING2);
    const url = DriveApp.getFileById(docId).getUrl();
    return {
      success: true,
      message: 'Section "' + sectionLabel + '" created. You can now add to-dos with addTeamTodo(sectionLabel: "' + sectionLabel + '", taskText: "…").',
      url: url,
      sectionLabel: sectionLabel
    };
  } catch (err) {
    return { error: err.message || err.toString() };
  }
}

/**
 * Add a to-do item to the team to-do Doc under the given section. Use section (enum) or sectionLabel. Does not create new sections; use createTeamTodoSection first after user confirms.
 * @param {{ section?: string, sectionLabel?: string, taskText: string, fileId?: string }} args
 * @returns {{ success: boolean, message?: string, url?: string, sectionLabel?: string, error?: string }}
 */
function addTeamTodo(args) {
  try {
    const docId = (args.fileId && (args.fileId + '').trim()) ? (args.fileId + '').trim() : getTeamTodoDocId();
    if (!docId) {
      return { error: 'Set TEAM_TODO_DOC_ID in Script Properties, or pass fileId.' };
    }
    const taskText = (args.taskText || '').trim();
    if (!taskText) {
      return { error: 'taskText is required.' };
    }
    let sectionHeading = null;
    const sectionLabelRaw = (args.sectionLabel && (args.sectionLabel + '').trim()) ? (args.sectionLabel + '').trim() : null;
    const sectionKey = (args.section && (args.section + '').trim()) ? (args.section + '').trim().toLowerCase() : null;
    if (sectionLabelRaw) {
      sectionHeading = sectionLabelRaw;
    } else if (sectionKey) {
      sectionHeading = TEAM_TODO_SECTION_HEADINGS[sectionKey];
    }
    if (!sectionHeading) {
      return { error: 'Provide either section (one of: me, account_development_reps, solutions_architects, scaled_solutions_architects, specialists) or sectionLabel for a custom section. For new sections, call listTeamTodoSections, then ask the user to add to an existing section or create a new one; only after they confirm call createTeamTodoSection then addTeamTodo.' };
    }
    const doc = DocumentApp.openById(docId);
    const body = doc.getBody();
    const headingIndex = findTeamTodoHeading2Index(body, sectionHeading);
    if (headingIndex === -1) {
      return { error: 'Section "' + sectionHeading + '" not found. Call listTeamTodoSections to show existing sections; ask the user whether to add to one of those or create a new section. Only after they confirm, call createTeamTodoSection(sectionLabel: "' + sectionHeading + '") then addTeamTodo again.' };
    }
    const insertIndex = headingIndex + 1;
    body.insertParagraph(insertIndex, '☐ ' + taskText);
    const url = DriveApp.getFileById(docId).getUrl();
    return {
      success: true,
      message: 'To-do added under ' + sectionHeading + '.',
      url: url,
      sectionLabel: sectionHeading
    };
  } catch (err) {
    return { error: err.message || err.toString() };
  }
}

/**
 * Score how well candidate text matches search text (higher = better). Uses case-insensitive substring then word overlap.
 * @param {string} candidate - Full paragraph text
 * @param {string} search - User's search text
 * @returns {number}
 */
function scoreTodoMatch(candidate, search) {
  var c = (candidate || '').trim().toLowerCase();
  var s = (search || '').trim().toLowerCase();
  if (!s) return 0;
  if (c.indexOf(s) !== -1) return 1000;
  if (s.indexOf(c) !== -1) return 500;
  var searchWords = s.split(/\s+/).filter(function(w) { return w.length > 0; });
  var count = 0;
  for (var i = 0; i < searchWords.length; i++) {
    if (c.indexOf(searchWords[i]) !== -1) count++;
  }
  return searchWords.length > 0 ? (count / searchWords.length) * 100 : 0;
}

/**
 * Collect open (non-done) todo paragraph texts in a section (from sectionStart+1 until next H2).
 * @param {GoogleAppsScript.Document.Body} body
 * @param {number} sectionStart - Index of the section Heading 2
 * @returns {string[]}
 */
function getOpenTodosInSection(body, sectionStart) {
  var todos = [];
  var n = body.getNumChildren();
  for (var i = sectionStart + 1; i < n; i++) {
    var child = body.getChild(i);
    if (child.getType() === DocumentApp.ElementType.PARAGRAPH && child.asParagraph().getHeading() === DocumentApp.ParagraphHeading.HEADING2) {
      break;
    }
    if (child.getType() !== DocumentApp.ElementType.PARAGRAPH) continue;
    var text = child.asParagraph().getText().trim();
    if (text) todos.push(text);
  }
  return todos;
}

/**
 * Mark a team to-do as done: find paragraph containing taskText in the section, remove it, append under "[Role] — Done".
 * If no exact match, returns needsConfirmation with suggestedTaskText and availableTodos; agent should ask user to confirm then retry with suggestedTaskText.
 * On success, returns remainingTodos so the agent can list them as additional options.
 * Use section (enum) or sectionLabel for custom sections.
 * @param {{ section?: string, sectionLabel?: string, taskText: string, fileId?: string }} args
 * @returns {{ success?: boolean, message?: string, markedDone?: string, remainingTodos?: string[], error?: string, needsConfirmation?: boolean, suggestedTaskText?: string, availableTodos?: string[] }}
 */
function markTeamTodoDone(args) {
  try {
    const docId = (args.fileId && (args.fileId + '').trim()) ? (args.fileId + '').trim() : getTeamTodoDocId();
    if (!docId) {
      return { error: 'Set TEAM_TODO_DOC_ID in Script Properties, or pass fileId.' };
    }
    let sectionHeading = null;
    const sectionLabelRaw = (args.sectionLabel && (args.sectionLabel + '').trim()) ? (args.sectionLabel + '').trim() : null;
    const sectionKey = (args.section && (args.section + '').trim()) ? (args.section + '').trim().toLowerCase() : null;
    if (sectionLabelRaw) {
      sectionHeading = sectionLabelRaw;
    } else if (sectionKey) {
      sectionHeading = TEAM_TODO_SECTION_HEADINGS[sectionKey];
    }
    if (!sectionHeading) {
      return { error: 'Provide either section (one of: me, account_development_reps, solutions_architects, scaled_solutions_architects, specialists) or sectionLabel for a custom section.' };
    }
    const searchText = (args.taskText || '').trim();
    if (!searchText) {
      return { error: 'taskText is required to identify the to-do to mark done.' };
    }
    const doc = DocumentApp.openById(docId);
    const body = doc.getBody();
    const sectionStart = findTeamTodoHeading2Index(body, sectionHeading);
    if (sectionStart === -1) {
      return { error: 'Section heading "' + sectionHeading + '" not found in the document.' };
    }
    const n = body.getNumChildren();
    let sectionEnd = n;
    for (let i = sectionStart + 1; i < n; i++) {
      const child = body.getChild(i);
      if (child.getType() === DocumentApp.ElementType.PARAGRAPH && child.asParagraph().getHeading() === DocumentApp.ParagraphHeading.HEADING2) {
        sectionEnd = i;
        break;
      }
    }
    let foundPara = null;
    let foundIndex = -1;
    for (let i = sectionStart + 1; i < sectionEnd; i++) {
      const child = body.getChild(i);
      if (child.getType() !== DocumentApp.ElementType.PARAGRAPH) continue;
      const text = child.asParagraph().getText();
      if (text.indexOf(searchText) !== -1) {
        foundPara = child.asParagraph();
        foundIndex = i;
        break;
      }
    }
    if (!foundPara) {
      const availableTodos = getOpenTodosInSection(body, sectionStart);
      if (availableTodos.length === 0) {
        return { error: 'No open to-dos in section "' + sectionHeading + '". Nothing to mark done.' };
      }
      var bestScore = 0;
      var suggestedTaskText = null;
      for (var j = 0; j < availableTodos.length; j++) {
        var score = scoreTodoMatch(availableTodos[j], searchText);
        if (score > bestScore) {
          bestScore = score;
          suggestedTaskText = availableTodos[j];
        }
      }
      return {
        needsConfirmation: true,
        suggestedTaskText: suggestedTaskText || availableTodos[0],
        availableTodos: availableTodos,
        message: 'No exact match for "' + searchText + '". Suggest closest match; ask user to confirm, then call markTeamTodoDone again with taskText set to suggestedTaskText. After success, list remainingTodos as additional options.'
      };
    }
    const fullText = foundPara.getText().trim();
    foundPara.removeFromParent();
    const doneHeadingText = sectionHeading + ' — Done';
    const normalizedText = fullText.replace(/^[☐☑]\s*/, '');
    const doneHeadingIndex = findTeamTodoHeading2Index(body, doneHeadingText);
    if (doneHeadingIndex === -1) {
      body.appendParagraph(doneHeadingText).setHeading(DocumentApp.ParagraphHeading.HEADING2);
      body.appendParagraph('☑ ' + normalizedText);
    } else {
      body.insertParagraph(doneHeadingIndex + 1, '☑ ' + normalizedText);
    }
    const remainingTodos = getOpenTodosInSection(body, sectionStart);
    return {
      success: true,
      message: 'To-do marked done and moved to ' + doneHeadingText + '.',
      markedDone: normalizedText,
      remainingTodos: remainingTodos
    };
  } catch (err) {
    return { error: err.message || err.toString() };
  }
}

/**
 * List all open (non-done) to-dos under a section. Returns paragraph text for each item between the section heading and the next Heading 2.
 * @param {{ section?: string, sectionLabel?: string, fileId?: string }} args
 * @returns {{ section: string, todos: string[] } | { error: string }}
 */
function listTeamTodoOpen(args) {
  try {
    const docId = (args.fileId && (args.fileId + '').trim()) ? (args.fileId + '').trim() : getTeamTodoDocId();
    if (!docId) {
      return { error: 'Set TEAM_TODO_DOC_ID in Script Properties, or pass fileId.' };
    }
    let sectionHeading = null;
    const sectionLabelRaw = (args.sectionLabel && (args.sectionLabel + '').trim()) ? (args.sectionLabel + '').trim() : null;
    const sectionKey = (args.section && (args.section + '').trim()) ? (args.section + '').trim().toLowerCase() : null;
    if (sectionLabelRaw) {
      sectionHeading = sectionLabelRaw;
    } else if (sectionKey) {
      sectionHeading = TEAM_TODO_SECTION_HEADINGS[sectionKey];
    }
    if (!sectionHeading) {
      return { error: 'Provide either section (one of: me, account_development_reps, solutions_architects, scaled_solutions_architects, specialists) or sectionLabel.' };
    }
    const doc = DocumentApp.openById(docId);
    const body = doc.getBody();
    const sectionStart = findTeamTodoHeading2Index(body, sectionHeading);
    if (sectionStart === -1) {
      return { error: 'Section "' + sectionHeading + '" not found in the document.' };
    }
    const n = body.getNumChildren();
    let sectionEnd = n;
    for (let i = sectionStart + 1; i < n; i++) {
      const child = body.getChild(i);
      if (child.getType() === DocumentApp.ElementType.PARAGRAPH && child.asParagraph().getHeading() === DocumentApp.ParagraphHeading.HEADING2) {
        sectionEnd = i;
        break;
      }
    }
    const todos = [];
    for (let i = sectionStart + 1; i < sectionEnd; i++) {
      const child = body.getChild(i);
      if (child.getType() !== DocumentApp.ElementType.PARAGRAPH) continue;
      const text = child.asParagraph().getText().trim();
      if (text) todos.push(text);
    }
    return { section: sectionHeading, todos: todos };
  } catch (err) {
    return { error: err.message || err.toString() };
  }
}

/**
 * List all open (non-done) to-dos across every section in the team to-do doc.
 * Scans all Heading 2 blocks that are not "— Done" blocks and collects open paragraphs.
 * @param {{ fileId?: string }} args
 * @returns {{ sections: Array<{section: string, todos: string[]}> } | { error: string }}
 */
function listAllTeamTodosOpen(args) {
  try {
    const docId = (args.fileId && (args.fileId + '').trim()) ? (args.fileId + '').trim() : getTeamTodoDocId();
    if (!docId) {
      return { error: 'Set TEAM_TODO_DOC_ID in Script Properties, or pass fileId.' };
    }
    const doc = DocumentApp.openById(docId);
    const body = doc.getBody();
    const n = body.getNumChildren();
    const sections = [];
    var currentSection = null;

    for (var i = 0; i < n; i++) {
      const child = body.getChild(i);
      if (child.getType() !== DocumentApp.ElementType.PARAGRAPH) continue;
      const para = child.asParagraph();
      const heading = para.getHeading();
      if (heading === DocumentApp.ParagraphHeading.HEADING2) {
        const headingText = para.getText().trim();
        if (headingText.indexOf(' — Done') !== -1 || headingText.indexOf(' \u2014 Done') !== -1) {
          currentSection = null;
        } else {
          currentSection = { section: headingText, todos: [] };
          sections.push(currentSection);
        }
        continue;
      }
      if (currentSection) {
        const text = para.getText().trim();
        if (text) currentSection.todos.push(text);
      }
    }

    return { sections: sections };
  } catch (err) {
    return { error: err.message || err.toString() };
  }
}

/**
 * Returns true if a file name should be treated as a notes doc (fuzzy: contains "notes", case-insensitive).
 */
function nameLooksLikeNotes(name) {
  if (!name || typeof name !== 'string') return false;
  return name.toLowerCase().indexOf('notes') !== -1;
}

/**
 * Read-only: find notes docs in a folder. Matches any Google Doc whose name contains "notes" (e.g. "Notes", "Account Notes", "Ongoing notes"). Returns { docs: [{ name, fileId, url }] } or { error }.
 * Does not create; use when user only wants to find or get a link.
 */
function findNotesInFolder(args) {
  try {
    const folder = DriveApp.getFolderById(args.folderId);
    const docs = [];
    const iter = folder.getFilesByType(MimeType.GOOGLE_DOCS);
    while (iter.hasNext()) {
      const file = iter.next();
      const name = file.getName();
      if (nameLooksLikeNotes(name)) {
        docs.push({ name: name, fileId: file.getId(), url: file.getUrl() });
      }
    }
    return { docs: docs };
  } catch (err) {
    return { error: err.message || err.toString() };
  }
}

/**
 * Find or create a notes doc in the folder. Matches any doc whose name contains "notes" (e.g. "Ongoing notes", "Account Notes"); creates one only if none found. Returns { fileId, url } or { error }.
 */
function getOrCreateNotesDoc(args) {
  try {
    const folder = DriveApp.getFolderById(args.folderId);
    const preferredName = args.preferredName ? (args.preferredName + '').trim() : null;
    const iter = folder.getFilesByType(MimeType.GOOGLE_DOCS);
    while (iter.hasNext()) {
      const file = iter.next();
      const name = file.getName();
      if (nameLooksLikeNotes(name)) {
        return { fileId: file.getId(), url: file.getUrl() };
      }
    }
    const newName = preferredName || 'Notes';
    const doc = DocumentApp.create(newName);
    const docId = doc.getId();
    const docFile = DriveApp.getFileById(docId);
    docFile.moveTo(folder);
    return { fileId: docId, url: docFile.getUrl() };
  } catch (err) {
    return { error: err.message || err.toString() };
  }
}

/**
 * Parse a trimmed notes line into type and content. Returns { type: 'h2'|'h3'|'bullet'|'paragraph', text }.
 */
function parseNotesLineType(line) {
  const trimmed = (line || '').trim();
  if (/^##\s/.test(trimmed)) {
    return { type: 'h2', text: trimmed.replace(/^##\s*/, '').trim() };
  }
  if (/^###\s/.test(trimmed)) {
    return { type: 'h3', text: trimmed.replace(/^###\s*/, '').trim() };
  }
  if (/^[-*]\s/.test(trimmed)) {
    return { type: 'bullet', text: trimmed.replace(/^[-*]\s*/, '').trim() };
  }
  return { type: 'paragraph', text: trimmed };
}

/**
 * Parse markdown-style bold/italic in content. Returns { plainText, segments } where segments are { start, end, bold, italic }.
 * Supports **bold**, *italic*, and ***bold+italic***.
 */
function parseNotesRichText(content) {
  let plainText = '';
  const segments = [];
  let pos = 0;
  const s = String(content || '');
  while (pos < s.length) {
    const rest = s.slice(pos);
    let m = rest.match(/^\*\*\*(.*?)\*\*\*/);
    if (m) {
      const start = plainText.length;
      plainText += m[1];
      segments.push({ start: start, end: plainText.length, bold: true, italic: true });
      pos += m[0].length;
      continue;
    }
    m = rest.match(/^\*\*(.*?)\*\*/);
    if (m) {
      const start = plainText.length;
      plainText += m[1];
      segments.push({ start: start, end: plainText.length, bold: true, italic: false });
      pos += m[0].length;
      continue;
    }
    m = rest.match(/^\*([^*]*)\*/);
    if (m) {
      const start = plainText.length;
      plainText += m[1];
      segments.push({ start: start, end: plainText.length, bold: false, italic: true });
      pos += m[0].length;
      continue;
    }
    plainText += rest[0];
    pos += 1;
  }
  return { plainText: plainText, segments: segments };
}

/**
 * Apply rich-text segments to a paragraph or list item via editAsText(). Element must already contain plainText.
 */
function applyNotesRichTextToElement(element, plainText, segments) {
  if (!element || !segments || segments.length === 0) return;
  try {
    const text = element.editAsText();
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (seg.start < seg.end && seg.end <= plainText.length) {
        if (seg.bold) text.setBold(seg.start, seg.end - 1, true);
        if (seg.italic) text.setItalic(seg.start, seg.end - 1, true);
      }
    }
  } catch (e) { /* ignore if element doesn't support editAsText */ }
}

/**
 * Normalize a Google Doc fileId: accept raw ID or URL; return trimmed ID or null if invalid.
 */
function normalizeDocFileId(fileId) {
  if (fileId == null || (typeof fileId !== 'string' && typeof fileId !== 'number')) return null;
  const s = String(fileId).trim();
  if (!s) return null;
  const m = s.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]+$/.test(s)) return s;
  return null;
}

/**
 * Returns a flat list of all tabs in the document (top-level and nested). Used when the doc uses
 * Google Docs "tabs" (organizational tabs). Each tab has getId(), getTitle(), asDocumentTab().getBody().
 * If doc.getTabs is not available (older runtime), returns [].
 */
function getAllDocTabs(doc) {
  if (!doc || typeof doc.getTabs !== 'function') return [];
  const allTabs = [];
  function addTabs(tabs) {
    if (!tabs || !tabs.length) return;
    for (let i = 0; i < tabs.length; i++) {
      allTabs.push(tabs[i]);
      if (typeof tabs[i].getChildTabs === 'function') addTabs(tabs[i].getChildTabs());
    }
  }
  addTabs(doc.getTabs());
  return allTabs;
}

/**
 * Get the Body to use for append/prepend. When the document has tabs, doc.getBody() is the first tab only.
 * If tabId or tabTitle is provided, use that tab's body; otherwise use doc.getBody() (first tab).
 * @returns {{ body: GoogleAppsScript.Document.Body } | { error: string }}
 */
function getDocBodyForAppend(doc, args) {
  const tabIdRaw = args.tabId != null && (args.tabId + '').trim() ? (args.tabId + '').trim() : null;
  const tabTitleRaw = args.tabTitle != null && (args.tabTitle + '').trim() ? (args.tabTitle + '').trim() : null;
  if (!tabIdRaw && !tabTitleRaw) {
    return { body: doc.getBody() };
  }
  if (typeof doc.getTabs !== 'function') {
    return { error: 'This document does not support tabs; tabId/tabTitle cannot be used.' };
  }
  if (tabIdRaw) {
    try {
      const tab = doc.getTab(tabIdRaw);
      if (!tab || typeof tab.asDocumentTab !== 'function') return { error: 'Tab not found for tabId: ' + tabIdRaw };
      return { body: tab.asDocumentTab().getBody() };
    } catch (e) {
      return { error: 'Tab not found for tabId "' + tabIdRaw + '". ' + (e.message || e.toString()) };
    }
  }
  const allTabs = getAllDocTabs(doc);
  const lowerTitle = tabTitleRaw.toLowerCase();
  for (let i = 0; i < allTabs.length; i++) {
    const t = allTabs[i];
    const title = typeof t.getTitle === 'function' ? (t.getTitle() || '') : '';
    if (title.toLowerCase() === lowerTitle) {
      try {
        return { body: t.asDocumentTab().getBody() };
      } catch (e) {
        return { error: 'Could not get body for tab "' + title + '". ' + (e.message || e.toString()) };
      }
    }
  }
  return { error: 'No tab found with title "' + tabTitleRaw + '". Available tabs: ' + allTabs.map(function(t) { return (typeof t.getTitle === 'function' ? t.getTitle() : '?'); }).join(', ') };
}

/**
 * Append or prepend notes to a Google Doc. Prepend defaults to true: insert at the beginning with Heading 2 (title), Heading 3 (date), then notes body. Pass prepend: false to append (e.g. for opp or workload).
 * notesText can use markdown-lite: ## and ### for headings, - or * at line start for bullets, **bold** and *italic* for rich text.
 */
function appendNotesToDoc(args) {
  try {
    const fileId = normalizeDocFileId(args.fileId);
    if (!fileId) {
      return { error: 'Invalid or missing fileId. Provide the document ID or the full Doc URL (e.g. https://docs.google.com/document/d/.../edit).' };
    }
    if (args.notesText == null || (typeof args.notesText !== 'string' && typeof args.notesText !== 'number')) {
      return { error: 'Missing or invalid notesText.' };
    }
    const doc = DocumentApp.openById(fileId);
    const bodyResult = getDocBodyForAppend(doc, args);
    if (bodyResult.error) return { error: bodyResult.error };
    const body = bodyResult.body;
    const sourceLabel = (args.sourceLabel && (args.sourceLabel + '').trim()) ? (args.sourceLabel + '').trim() : null;
    const prepend = args.prepend !== false;
    const headingTitleRaw = (args.headingTitle && (args.headingTitle + '').trim()) ? (args.headingTitle + '').trim() : null;
    const headingTitle = headingTitleRaw || 'Notes';
    const tz = Session.getScriptTimeZone();
    const dateStr = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
    const text = (args.notesText || '').trim();
    const lines = text.split('\n');

    if (prepend) {
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i] || '';
        const parsed = parseNotesLineType(line);
        const rich = parseNotesRichText(parsed.text);
        const plain = rich.plainText;
        const segs = rich.segments;
        if (parsed.type === 'h2') {
          const el = body.insertParagraph(0, plain);
          el.setHeading(DocumentApp.ParagraphHeading.HEADING2);
          applyNotesRichTextToElement(el, plain, segs);
        } else if (parsed.type === 'h3') {
          const el = body.insertParagraph(0, plain);
          el.setHeading(DocumentApp.ParagraphHeading.HEADING3);
          applyNotesRichTextToElement(el, plain, segs);
        } else if (parsed.type === 'bullet') {
          const el = body.insertListItem(0, plain);
          el.setGlyphType(DocumentApp.GlyphType.BULLET);
          applyNotesRichTextToElement(el, plain, segs);
        } else {
          const el = body.insertParagraph(0, plain);
          applyNotesRichTextToElement(el, plain, segs);
        }
      }
      body.insertParagraph(0, '');
      const datePara = body.insertParagraph(0, dateStr);
      datePara.setHeading(DocumentApp.ParagraphHeading.HEADING3);
      const titlePara = body.insertParagraph(0, headingTitle);
      titlePara.setHeading(DocumentApp.ParagraphHeading.HEADING2);
      return { success: true, message: 'Notes prepended with heading.' };
    }

    body.appendParagraph('');
    if (sourceLabel) {
      body.appendParagraph('--- ' + dateStr + ' (' + sourceLabel + ') ---');
    } else {
      body.appendParagraph('--- ' + dateStr + ' ---');
    }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] || '';
      const parsed = parseNotesLineType(line);
      const rich = parseNotesRichText(parsed.text);
      const plain = rich.plainText;
      const segs = rich.segments;
      if (parsed.type === 'h2') {
        const el = body.appendParagraph(plain);
        el.setHeading(DocumentApp.ParagraphHeading.HEADING2);
        applyNotesRichTextToElement(el, plain, segs);
      } else if (parsed.type === 'h3') {
        const el = body.appendParagraph(plain);
        el.setHeading(DocumentApp.ParagraphHeading.HEADING3);
        applyNotesRichTextToElement(el, plain, segs);
      } else if (parsed.type === 'bullet') {
        const el = body.appendListItem(plain);
        el.setGlyphType(DocumentApp.GlyphType.BULLET);
        applyNotesRichTextToElement(el, plain, segs);
      } else {
        const el = body.appendParagraph(plain);
        applyNotesRichTextToElement(el, plain, segs);
      }
    }
    return { success: true, message: 'Notes appended.' };
  } catch (err) {
    const msg = (err && (err.message || err.toString())) || 'Unknown error';
    const lower = msg.toLowerCase();
    if (lower.indexOf('permission') !== -1 || lower.indexOf('access') !== -1 || lower.indexOf('authorize') !== -1) {
      return { error: 'Permission denied: the script cannot edit this document. Ensure the Doc is shared with the Google account that runs the script (Editor access). If the Doc is in a Shared Drive, that account must have edit access there. ' + msg };
    }
    if (lower.indexOf('missing') !== -1 || lower.indexOf('not found') !== -1 || lower.indexOf('invalid') !== -1 || lower.indexOf('deleted') !== -1) {
      return { error: 'Document not found or invalid. Check that the document ID is correct and the file still exists. ' + msg };
    }
    return { error: msg };
  }
}

/**
 * Store pending notes for an email thread (ask-first flow). Payload can include prepend and headingTitle for account-folder prepend format on confirm.
 */
function storePendingNotesConfirmation(args) {
  try {
    const key = GWSMCP_PENDING_PREFIX + (args.threadId || '');
    const payload = {
      fileId: args.fileId,
      notesText: args.notesText,
      sourceLabel: args.sourceLabel,
      pathDescription: args.pathDescription
    };
    if (args.prepend === true) payload.prepend = true;
    if (args.prepend === false) payload.prepend = false;
    if (args.headingTitle && (args.headingTitle + '').trim()) payload.headingTitle = (args.headingTitle + '').trim();
    if (args.tabId && (args.tabId + '').trim()) payload.tabId = (args.tabId + '').trim();
    if (args.tabTitle && (args.tabTitle + '').trim()) payload.tabTitle = (args.tabTitle + '').trim();
    PropertiesService.getScriptProperties().setProperty(key, JSON.stringify(payload));
    return { success: true, message: 'Pending notes stored. User can reply "yes" to confirm.' };
  } catch (err) {
    return { error: err.message || err.toString() };
  }
}

/**
 * Get stored pending notes for a thread, if any.
 */
function getPendingNotesForThread(args) {
  try {
    const key = GWSMCP_PENDING_PREFIX + (args.threadId || '');
    const raw = PropertiesService.getScriptProperties().getProperty(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    return { error: err.message || err.toString() };
  }
}

/**
 * Clear stored pending notes for a thread.
 */
function clearPendingNotes(args) {
  try {
    const key = GWSMCP_PENDING_PREFIX + (args.threadId || '');
    PropertiesService.getScriptProperties().deleteProperty(key);
    return { success: true };
  } catch (err) {
    return { error: err.message || err.toString() };
  }
}

function createResponse(data, code = 200) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Chat endpoint for the Web UI chatbot. Accepts full conversation history so the
 * agent "remembers" the current chat. Runs the same agent loop as doPost; when
 * the assistant returns content only (e.g. asking for more info), returns immediately
 * so the user can reply. When tools run and create a deck, returns finalResult.url.
 * @param {Array<{role: string, content: string}>} messages - Conversation history (user + assistant messages only).
 * @param {boolean} [authorizedByKey] - If true, skip email allowlist (e.g. caller already validated via CHROME_EXTENSION_API_KEY).
 * @returns {{ reply: string, finalResult?: { url?: string } }}
 */
function chatWithMCP(messages, authorizedByKey) {
  if (!authorizedByKey) {
    var callerEmail = Session.getActiveUser().getEmail().toLowerCase();
    if (!isWebAppUserAllowed(callerEmail)) {
      return { reply: 'Access denied. Reach out to shaun.banta@mongodb.com if you want access.', finalResult: null };
    }
  }
  const systemContent = "You are a Google Workspace orchestrator. You help users create 'New Workload' presentations and add email/meeting notes to Drive. For workload decks: use search tools, then createNewWorkloadPresentation. When the user only wants to find notes or get a link (e.g. 'look for notes in X folder', 'give me the link'), use getNotesRootFolderId, resolveNotesLocation with accountName and optionally oppName or workloadName, then findNotesInFolder(folderId); do not use getOrCreateNotesDoc. You can add or search notes in (1) account folder, (2) Account > Opps > [Opp] > Notes, or (3) Account > Workloads > [Workload]. For saving notes: use getNotesRootFolderId, extract account and optionally opportunity or workload, and only the meeting/information notes; call resolveNotesLocation (with oppName or workloadName if applicable), getOrCreateNotesDoc. appendNotesToDoc prepends by default (optionally set headingTitle); for opp or workload pass prepend: false. Format notes with ##, ###, - or * for structure and **bold**/ *italic* for emphasis so formatting is preserved. Ask first: only call appendNotesToDoc after the user confirms, unless they already granted permission (e.g. 'add these notes', 'yes add them'). If asking, reply and do not append; on the next turn when they say 'yes', re-run resolution and append with prepend/headingTitle for account folder. If you need more information (e.g. document URL, client name), ask in plain text. When the user wants to create a new workload folder or set up a workload with its own notes: (1) Call getNotesRootFolderId, then resolveWorkloadFolderWithSuggestions(rootFolderId, accountName, workloadName). (2) If match is 'exact', use that folder for adding notes (e.g. getOrCreateNotesDoc). (3) If match is 'none', tell the user the proposed folder name and full path and list existingWorkloads; ask whether to create the new folder at that path or add to an existing workload. (4) Only after the user explicitly confirms the folder name and location, call ensureWorkloadFolderAndNotes. Never create without confirming first. When the user asks to list all workloads for an account (e.g. 'list all the workload for an account', 'show workloads for X'), use getNotesRootFolderId then listWorkloadsForAccount(rootFolderId, accountName). When the user wants to view to-dos (e.g. 'show my to-dos', 'what do I have to do', 'list to-dos') without specifying a section, call listAllTeamTodosOpen immediately—do not ask which section. Only call listTeamTodoOpen when the user explicitly asks about a specific section. When the user wants to add a team to-do or mark one done, use addTeamTodo or markTeamTodoDone. For built-in roles use section; for a custom section use sectionLabel. Before creating a new section: call listTeamTodoSections, list the existing sections to the user, and ask whether to add to one of those or create a new section. Only when the user confirms, call createTeamTodoSection(sectionLabel) then addTeamTodo(sectionLabel, taskText). Never call createTeamTodoSection without confirming first. When markTeamTodoDone returns needsConfirmation (no exact match), ask the user 'Did you mean: [suggestedTaskText]?' and list availableTodos; on confirmation call markTeamTodoDone again with taskText set to suggestedTaskText. After any successful mark done, list remainingTodos as additional options. Never ask the user for a fileId or TEAM_TODO_DOC_ID proactively; just call the tool and only if it returns an error about the doc ID, explain that TEAM_TODO_DOC_ID needs to be set in Script Properties.";
  const fullMessages = [
    { role: "system", content: systemContent },
    ...(messages || [])
  ];

  let iterations = 0;
  const MAX_ITERATIONS = 10;
  let lastFinalResult = null;

  const allToolFns = {
    findFileByName: findFileByName,
    readDocContent: readDocContent,
    createNewWorkloadPresentation: createNewWorkloadPresentation,
    addCalendarReminder: addCalendarReminder,
    getNotesRootFolderId: getNotesRootFolderId,
    listSubfolders: listSubfolders,
    resolveNotesLocation: resolveNotesLocation,
    resolveWorkloadFolderWithSuggestions: resolveWorkloadFolderWithSuggestions,
    listWorkloadsForAccount: listWorkloadsForAccount,
    ensureWorkloadFolderAndNotes: ensureWorkloadFolderAndNotes,
    getOrCreateNotesDoc: getOrCreateNotesDoc,
    findNotesInFolder: findNotesInFolder,
    appendNotesToDoc: appendNotesToDoc,
    storePendingNotesConfirmation: storePendingNotesConfirmation,
    getPendingNotesForThread: getPendingNotesForThread,
    clearPendingNotes: clearPendingNotes,
    addTeamTodo: addTeamTodo,
    markTeamTodoDone: markTeamTodoDone,
    listTeamTodoSections: listTeamTodoSections,
    createTeamTodoSection: createTeamTodoSection,
    listTeamTodoOpen: listTeamTodoOpen,
    listAllTeamTodosOpen: listAllTeamTodosOpen,
    getWorkloadSheetData: getWorkloadSheetData
  };

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    var response;
    try {
      response = callAzure(fullMessages);
    } catch (azureErr) {
      Logger.log('[chatWithMCP] callAzure threw (iter ' + iterations + '): ' + azureErr.toString());
      return { reply: 'Azure request failed: ' + azureErr.toString(), finalResult: null };
    }
    const assistantMessage = response.choices[0].message;
    fullMessages.push(assistantMessage);

    if (assistantMessage.tool_calls) {
      const toolFns = allToolFns;
      assistantMessage.tool_calls.forEach(function(toolCall) {
        const functionName = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments);
        let result;
        try {
          result = toolFns[functionName] ? toolFns[functionName](args) : "Error: unknown tool";
        } catch (err) {
          result = "Error: " + err.toString();
        }
        if (result && typeof result === "object" && result.url) {
          lastFinalResult = { url: result.url };
        }
        fullMessages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          name: functionName,
          content: JSON.stringify(result)
        });
      });
      continue;
    }

    const reply = (assistantMessage.content && assistantMessage.content.trim()) ? assistantMessage.content : "I'm not sure how to respond. Please try rephrasing or provide more context.";
    return { reply: reply, finalResult: lastFinalResult || undefined };
  }

  const lastContent = fullMessages[fullMessages.length - 1].content;
  return {
    reply: (lastContent && lastContent.trim()) ? lastContent : "I hit the iteration limit. Please try again with a shorter conversation or a more specific request.",
    finalResult: lastFinalResult || undefined
  };
}

/**
 * Serves the HTML page when the URL is visited in a browser.
 */
function doGet(e) {
  var userEmail = Session.getActiveUser().getEmail().toLowerCase();
  if (!isWebAppUserAllowed(userEmail)) {
    return HtmlService.createHtmlOutput(
      '<html><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f5f5;">' +
      '<div style="text-align:center;padding:40px;background:white;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,0.1);max-width:480px;">' +
      '<h2 style="color:#cc0000;">Access Restricted</h2>' +
      '<p>You don\'t have access to this tool.</p>' +
      '<p>Reach out to <a href="mailto:shaun.banta@mongodb.com">shaun.banta@mongodb.com</a> if you want access.</p>' +
      '</div></body></html>'
    ).setTitle('Access Restricted');
  }
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('MongoDB Sales Orchestrator')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * Check if the given email is allowed to use the web app.
 * Uses the same GWSMCP_ALLOWED_SENDERS Script Property as the email tool.
 * If the property is unset/empty, falls back to allowing anyone @mongodb.com.
 * @param {string} email - Lowercase email address of the current user.
 * @returns {boolean}
 */
function isWebAppUserAllowed(email) {
  var raw = PropertiesService.getScriptProperties().getProperty('GWSMCP_ALLOWED_SENDERS');
  if (!raw || !raw.trim()) {
    return email.endsWith('@mongodb.com');
  }
  var list = raw.split(/[\n,]+/).map(function(s) { return s.trim().toLowerCase(); }).filter(function(s) { return s.length > 0; });
  return list.indexOf(email) !== -1;
}

/**
 * Triggered by the HTML form. 
 * Merges document context + prompt and runs the Agent Loop.
 */
function processForm(docUrl, extraPrompt) {
  try {
    // 1. Extract ID and read the document
    const docId = extractIdFromUrl(docUrl);
    const docContent = DocumentApp.openById(docId).getBody().getText();
    
    // 2. Build the master prompt
    const masterPrompt = `
      I am providing a notes document and additional instructions. 
      Please create a New Workload Presentation based on this data.
      
      DOCUMENT CONTENT:
      ${docContent}
      
      ADDITIONAL INSTRUCTIONS:
      ${extraPrompt}
    `;
    
    // 3. Reuse your existing Agent logic
    // We call the logic inside doPost but pass the prompt directly
    return runAgentLoop(masterPrompt);
    
  } catch (e) {
    throw new Error("Failed to process request: " + e.message);
  }
}

/**
 * Helper to get ID from a full Google Doc URL
 */
function extractIdFromUrl(url) {
  const match = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : url;
}

/**
 * Refactored Agent Loop (Extracted from doPost so both UI and API can use it)
 */
function runAgentLoop(prompt) {
  let messages = [
    { role: "system", content: "You are a Google Workspace orchestrator. Use the createNewWorkloadPresentation tool to build a deck based on the provided context." },
    { role: "user", content: prompt }
  ];

  let iterations = 0;
  while (iterations < 10) {
    iterations++;
    const response = callAzure(messages);
    const assistantMessage = response.choices[0].message;
    messages.push(assistantMessage);

    if (assistantMessage.tool_calls) {
      // For the UI version, we'll just handle the first tool call for simplicity
      const toolCall = assistantMessage.tool_calls[0];
      const args = JSON.parse(toolCall.function.arguments);
      return createNewWorkloadPresentation(args); // Return the final URL object
    }
  }
}

/**
 * Agent loop for email-triggered invocation. Runs the full loop (multiple tool calls
 * until the model returns content-only), then returns { finalAnswer, url? } for the
 * email listener to use as the reply body.
 * @param {string} prompt - User prompt from the email body.
 * @returns {{ finalAnswer: string, url?: string }}
 */
function runAgentLoopForEmail(prompt) {
  if (typeof logGwsMcp === 'function') {
    logGwsMcp('[runAgentLoopForEmail] started, prompt length=' + (prompt ? prompt.length : 0));
  } else {
    Logger.log('[runAgentLoopForEmail] started, prompt length=' + (prompt ? prompt.length : 0));
  }
  const systemContent = "You are a Google Workspace orchestrator. You help users create 'New Workload' presentations and add email/meeting notes to Drive. For workload decks: use search tools, then createNewWorkloadPresentation. When the user only wants to find notes or get a link, use getNotesRootFolderId, resolveNotesLocation with accountName and optionally oppName or workloadName, then findNotesInFolder(folderId); do not use getOrCreateNotesDoc. You can add or search notes in (1) account folder, (2) Account > Opps > [Opp] > Notes, or (3) Account > Workloads > [Workload]. For saving email or meeting notes: if the prompt includes [ThreadId: ...], call getPendingNotesForThread(threadId) first; if it returns pending data and the user's message is a confirmation (e.g. 'yes'), call appendNotesToDoc with fileId, notesText, and pass through prepend and headingTitle from the pending payload if present, then clearPendingNotes and reply. Otherwise use getNotesRootFolderId, extract account and optionally opp or workload and notes text; call resolveNotesLocation (with oppName or workloadName if applicable), getOrCreateNotesDoc. Prepend is the default when storing pending notes; for opp or workload pass prepend: false in storePendingNotesConfirmation. Format notes with ##, ###, - or * for structure and **bold**/ *italic* for emphasis so formatting is preserved. Ask first unless the user already granted permission: then call storePendingNotesConfirmation and reply asking 'Reply yes to confirm.' Only call appendNotesToDoc when user has confirmed or already said to add. When the user wants to create a new workload folder or set up a workload with its own notes: (1) Call getNotesRootFolderId, then resolveWorkloadFolderWithSuggestions(rootFolderId, accountName, workloadName). (2) If match is 'exact', use that folder for adding notes. (3) If match is 'none', tell the user the proposed folder name and full path and list existingWorkloads; ask whether to create the new folder or add to an existing workload. (4) Only after the user explicitly confirms the folder name and location, call ensureWorkloadFolderAndNotes. Never create without confirming first. When the user asks to list all workloads for an account (e.g. 'list all the workload for an account', 'show workloads for X'), use getNotesRootFolderId then listWorkloadsForAccount(rootFolderId, accountName). When the user wants to view to-dos (e.g. 'show my to-dos', 'what do I have to do', 'list to-dos') without specifying a section, call listAllTeamTodosOpen immediately—do not ask which section. Only call listTeamTodoOpen when the user explicitly asks about a specific section. When the user wants to add a team to-do or mark one done, use addTeamTodo or markTeamTodoDone. For built-in roles use section; for a custom section use sectionLabel. Before creating a new section: call listTeamTodoSections, list the existing sections to the user, and ask whether to add to one of those or create a new section. Only when the user confirms, call createTeamTodoSection(sectionLabel) then addTeamTodo(sectionLabel, taskText). Never call createTeamTodoSection without confirming first. When markTeamTodoDone returns needsConfirmation (no exact match), ask the user 'Did you mean: [suggestedTaskText]?' and list availableTodos; on confirmation call markTeamTodoDone again with taskText set to suggestedTaskText. After any successful mark done, list remainingTodos as additional options. Never ask the user for a fileId or TEAM_TODO_DOC_ID proactively; just call the tool and only if it returns an error about the doc ID, explain that TEAM_TODO_DOC_ID needs to be set in Script Properties.";
  let messages = [
    { role: "system", content: systemContent },
    { role: "user", content: prompt }
  ];

  const toolFns = {
    findFileByName: findFileByName,
    readDocContent: readDocContent,
    createNewWorkloadPresentation: createNewWorkloadPresentation,
    addCalendarReminder: addCalendarReminder,
    getNotesRootFolderId: getNotesRootFolderId,
    listSubfolders: listSubfolders,
    resolveNotesLocation: resolveNotesLocation,
    resolveWorkloadFolderWithSuggestions: resolveWorkloadFolderWithSuggestions,
    listWorkloadsForAccount: listWorkloadsForAccount,
    ensureWorkloadFolderAndNotes: ensureWorkloadFolderAndNotes,
    getOrCreateNotesDoc: getOrCreateNotesDoc,
    findNotesInFolder: findNotesInFolder,
    appendNotesToDoc: appendNotesToDoc,
    storePendingNotesConfirmation: storePendingNotesConfirmation,
    getPendingNotesForThread: getPendingNotesForThread,
    clearPendingNotes: clearPendingNotes,
    addTeamTodo: addTeamTodo,
    markTeamTodoDone: markTeamTodoDone,
    listTeamTodoSections: listTeamTodoSections,
    createTeamTodoSection: createTeamTodoSection,
    listTeamTodoOpen: listTeamTodoOpen,
    listAllTeamTodosOpen: listAllTeamTodosOpen,
    getWorkloadSheetData: getWorkloadSheetData
  };
  let iterations = 0;
  const MAX_ITERATIONS = 10;
  let url = null;
  function logAgent(msg) {
    if (typeof logGwsMcp === 'function') { logGwsMcp(msg); } else { Logger.log(msg); }
  }

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    logAgent('[runAgentLoopForEmail] iteration ' + iterations + ' of ' + MAX_ITERATIONS + ', calling Azure...');
    let response;
    try {
      response = callAzure(messages);
    } catch (err) {
      logAgent('[runAgentLoopForEmail] callAzure threw: ' + err.toString());
      logAgent('[runAgentLoopForEmail] stack: ' + (err.stack || 'no stack'));
      throw err;
    }
    const assistantMessage = response.choices[0].message;
    messages.push(assistantMessage);

    if (assistantMessage.tool_calls) {
      logAgent('[runAgentLoopForEmail] iteration ' + iterations + ': got ' + assistantMessage.tool_calls.length + ' tool call(s)');
      assistantMessage.tool_calls.forEach(function(toolCall) {
        const functionName = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments);
        let result;
        try {
          result = toolFns[functionName] ? toolFns[functionName](args) : "Error: unknown tool";
          logAgent('[runAgentLoopForEmail] tool ' + functionName + ' returned (length ' + (typeof result === 'string' ? result.length : JSON.stringify(result).length) + ')');
        } catch (err) {
          logAgent('[runAgentLoopForEmail] tool ' + functionName + ' threw: ' + err.toString());
          result = "Error: " + err.toString();
        }
        if (result && typeof result === "object" && result.url) {
          url = result.url;
        }
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          name: functionName,
          content: JSON.stringify(result)
        });
      });
      continue;
    }

    const finalAnswer = (assistantMessage.content && assistantMessage.content.trim())
      ? assistantMessage.content
      : "I'm not sure how to respond. Please try rephrasing or provide more context.";
    logAgent('[runAgentLoopForEmail] returning final answer, length=' + finalAnswer.length + ', hasUrl=' + !!url);
    return { finalAnswer: finalAnswer, url: url || undefined };
  }

  logAgent('[runAgentLoopForEmail] hit iteration limit, returning fallback message');
  return {
    finalAnswer: "I hit the iteration limit. Please try again with a shorter request or more specific instructions.",
    url: url || undefined
  };
}

/**
 * Reads a tab from a Google Sheets spreadsheet and returns a structured list of workloads.
 * Each non-empty row after the header row is treated as one workload.
 * @param {{ sheetId: string, tabName: string, opportunityNameColumn?: string }} args
 * @returns {string} JSON string with workload data
 */
function getWorkloadSheetData(args) {
  var sheetId = (args.sheetId && args.sheetId.trim())
    ? args.sheetId.trim()
    : PropertiesService.getScriptProperties().getProperty('WORKLOAD_SHEET_ID');
  var tabName = args.tabName;
  var opportunityNameColumn = (args.opportunityNameColumn || 'Opportunity Name').trim();

  if (!sheetId) {
    return 'Error: No sheet ID provided and WORKLOAD_SHEET_ID is not set in Script Properties. ' +
      'Pass sheetId in the call or set WORKLOAD_SHEET_ID in Script Properties.';
  }

  var spreadsheet;
  try {
    spreadsheet = SpreadsheetApp.openById(sheetId);
  } catch (e) {
    return 'Error: Could not open spreadsheet with ID "' + sheetId + '". ' + e.toString();
  }

  var sheet = spreadsheet.getSheetByName(tabName);
  if (!sheet) {
    return 'Error: Tab "' + tabName + '" not found in spreadsheet. Available tabs: ' +
      spreadsheet.getSheets().map(function(s) { return s.getName(); }).join(', ');
  }

  var data = sheet.getDataRange().getValues();
  if (data.length < 1) {
    return 'No data found in tab "' + tabName + '".';
  }
  if (data.length < 2) {
    return 'Tab "' + tabName + '" has only a header row with no workload data.';
  }

  var headers = data[0].map(function(h) { return h.toString().trim(); });
  var oppColIndex = headers.findIndex(function(h) {
    return h.toLowerCase() === opportunityNameColumn.toLowerCase();
  });

  var workloads = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (row.every(function(cell) { return cell === '' || cell === null || cell === undefined; })) continue;

    var workloadObj = {};
    headers.forEach(function(header, idx) {
      var val = row[idx];
      workloadObj[header] = (val instanceof Date) ? val.toISOString() : val;
    });
    workloads.push(workloadObj);
  }

  return JSON.stringify({
    spreadsheetId: sheetId,
    tab: tabName,
    opportunityNameColumn: oppColIndex >= 0 ? opportunityNameColumn : null,
    opportunityNameColumnFound: oppColIndex >= 0,
    headers: headers,
    totalWorkloads: workloads.length,
    workloads: workloads
  }, null, 2);
}
