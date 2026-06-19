/**
 * CONFIGURATION
 * Use Script Properties for all deployment-time secrets/IDs.
 */
const DEFAULT_NOTES_ROOT_FOLDER_ID = '';

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

function getMongoConfig() {
  const props = PropertiesService.getScriptProperties();
  return {
    dataApiBaseUrl: (props.getProperty('MONGO_DATA_API_BASE_URL') || '').trim(),
    dataApiKey: (props.getProperty('MONGO_DATA_API_KEY') || '').trim(),
    dataSource: (props.getProperty('MONGO_DATA_SOURCE') || 'Cluster0').trim(),
    dbName: (props.getProperty('MONGO_DB_NAME') || 'sales_data').trim(),
    taskListsCollection: (props.getProperty('MONGO_TASK_LISTS_COLLECTION') || 'taskLists').trim(),
    tasksCollection: (props.getProperty('MONGO_TASKS_COLLECTION') || 'tasks').trim(),
    contactsCollection: (props.getProperty('MONGO_CONTACTS_COLLECTION') || 'contacts').trim(),
    workloadsCollection: (props.getProperty('MONGO_WORKLOADS_COLLECTION') || 'Workloads').trim()
  };
}

function getMainSystemContent() {
  return "You are a Google Workspace orchestrator. You can create workload decks, manage notes in Drive, and manage MongoDB task lists and contacts. For task lists use Mongo tools only: createTaskList, updateTaskList, addTaskToList, updateTaskInList, listTaskLists, getTaskList, deleteTaskList. Use updateTaskList to change the list name or owner; pass owner as an empty string to clear ownership (unowned list). listTaskLists owner matches either the owner field or the list name (case-insensitive). For contacts use Mongo tools only: addContact, updateContact, listContacts, getContact. Never use legacy Google Doc team to-do tools. For deleting task lists, always ask for explicit user confirmation first and only call deleteTaskList when confirm is true. Tasks are stored as separate Mongo documents linked by taskListId. status defaults to open if omitted. dueDate and person {name, title, role} are optional. Task priority is optional and must be one of: Priority 1, Priority 2, Priority 3, Priority 4. Contacts include name, title, optional email, reportsTo {contactId, name}, optional notes/freeText, and workloadIds. Keep notes behavior unchanged: ask before appendNotesToDoc unless the user already granted permission, and use getNotesRootFolderId + resolveNotesLocation flows for account/opp/workload notes.";
}

/**
 * API-only entry point used by the Node backend.
 *
 * Supported actions:
 * - { action: "getGoogleToolDefinitions", secret }
 * - { action: "executeTool", tool, args, secret }
 */
function doPost(e) {
  try {
    var body = {};
    try {
      body = JSON.parse(e.postData && e.postData.contents ? e.postData.contents : '{}');
    } catch (parseErr) {
      return createResponse({ ok: false, error: 'Invalid JSON body: ' + parseErr.toString() }, 400);
    }

    if (!isNodeRequestAuthorized(body.secret)) {
      return createResponse({ ok: false, error: 'Unauthorized' }, 401);
    }

    if (body.action === 'getGoogleToolDefinitions') {
      return createResponse({ ok: true, tools: getGoogleToolDefinitions() });
    }

    if (body.action === 'executeTool') {
      var toolName = (body.tool || '').trim();
      if (!toolName) return createResponse({ ok: false, error: 'Missing tool name' }, 400);

      var executorMap = getGoogleToolExecutorMap();
      var fn = executorMap[toolName];
      if (!fn) {
        return createResponse({ ok: false, error: 'Unknown or disallowed tool: ' + toolName }, 400);
      }

      var args = (body.args && typeof body.args === 'object') ? body.args : {};
      try {
        var result = fn(args);
        return createResponse({ ok: true, result: result });
      } catch (toolErr) {
        return createResponse({
          ok: false,
          error: 'Tool execution failed: ' + toolErr.toString(),
          tool: toolName
        }, 500);
      }
    }

    return createResponse({ ok: false, error: 'Unsupported action' }, 400);
  } catch (err) {
    return createResponse({ ok: false, error: err.toString() }, 500);
  }
}

function isNodeRequestAuthorized(secret) {
  var props = PropertiesService.getScriptProperties();
  var nodeSecret = (props.getProperty('NODE_TO_GAS_SECRET') || '').trim();
  var legacy = (props.getProperty('CHROME_EXTENSION_API_KEY') || '').trim();
  var expected = nodeSecret || legacy;
  if (!expected) return false;
  return (secret || '').trim() === expected;
}

function getMongoToolNameSet() {
  return {
    createTaskList: true,
    updateTaskList: true,
    addTaskToList: true,
    updateTaskInList: true,
    listTaskLists: true,
    getTaskList: true,
    deleteTaskList: true,
    addContact: true,
    updateContact: true,
    listContacts: true,
    getContact: true
  };
}

function getGoogleToolDefinitions() {
  var mongo = getMongoToolNameSet();
  return getToolDefinitions().filter(function(t) {
    var fn = t && t.function;
    return fn && fn.name && !mongo[fn.name];
  });
}

function getGoogleToolExecutorMap() {
  return {
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
    getWorkloadSheetData: getWorkloadSheetData
  };
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
        name: "createTaskList",
        description: "Create a MongoDB task list document. A list is the parent container for tasks.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Task list name." },
            owner: { type: "string", description: "Optional owner for the list." }
          },
          required: ["name"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "updateTaskList",
        description: "Update an existing MongoDB task list by ObjectId: change its name and/or owner. Pass owner as an empty string to clear ownership (no owner). Omitted fields stay unchanged.",
        parameters: {
          type: "object",
          properties: {
            taskListId: { type: "string", description: "Task list ObjectId string." },
            name: { type: "string", description: "New list name when changing the title." },
            owner: {
              type: "string",
              description:
                "New owner name when assigning ownership. Pass empty string to clear owner (unowned). Omit to leave owner unchanged."
            }
          },
          required: ["taskListId"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "addTaskToList",
        description: "Add one task document linked to an existing MongoDB task list by taskListId.",
        parameters: {
          type: "object",
          properties: {
            taskListId: { type: "string", description: "Task list document ObjectId string." },
            task: { type: "string", description: "Task text." },
            status: { type: "string", description: "Optional task status: open, in_progress, blocked, done. Defaults to open." },
            priority: { type: "string", description: "Optional priority: Priority 1, Priority 2, Priority 3, Priority 4." },
            dueDate: { type: "string", description: "Optional due date as ISO string." },
            person: {
              type: "object",
              properties: {
                name: { type: "string" },
                title: { type: "string" },
                role: { type: "string" }
              }
            },
            accountId: { type: "string", description: "Optional account reference ID for future use." },
            workloadId: { type: "string", description: "Optional workload reference ID for future use." }
          },
          required: ["taskListId", "task"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "updateTaskInList",
        description: "Update one task document linked to a task list by taskListId and taskId.",
        parameters: {
          type: "object",
          properties: {
            taskListId: { type: "string", description: "Task list document ObjectId string." },
            taskId: { type: "string", description: "Task ID generated when task was added." },
            task: { type: "string", description: "Updated task text." },
            status: { type: "string", description: "Updated status: open, in_progress, blocked, done." },
            priority: { type: "string", description: "Updated priority: Priority 1, Priority 2, Priority 3, Priority 4. Pass empty string to clear." },
            dueDate: { type: "string", description: "Updated due date ISO string. Pass empty string to clear." },
            person: {
              type: "object",
              properties: {
                name: { type: "string" },
                title: { type: "string" },
                role: { type: "string" }
              }
            },
            accountId: { type: "string", description: "Optional account reference ID." },
            workloadId: { type: "string", description: "Optional workload reference ID." }
          },
          required: ["taskListId", "taskId"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "listTaskLists",
        description: "List MongoDB task lists. owner matches the owner field OR the list name (case-insensitive). Optional q searches list name, owner, and task text.",
        parameters: {
          type: "object",
          properties: {
            owner: { type: "string", description: "Person or list label; matches owner or list name (case-insensitive)." },
            q: { type: "string", description: "Optional keyword search on list name, owner, and task text." },
            limit: { type: "number", description: "Optional max results, default 25." }
          },
          required: []
        }
      }
    },
    {
      type: "function",
      function: {
        name: "getTaskList",
        description: "Get one task list by ObjectId.",
        parameters: {
          type: "object",
          properties: {
            taskListId: { type: "string", description: "Task list ObjectId string." }
          },
          required: ["taskListId"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "deleteTaskList",
        description: "Delete one MongoDB task list document by ObjectId and remove linked task documents. Requires explicit confirm=true for safety.",
        parameters: {
          type: "object",
          properties: {
            taskListId: { type: "string", description: "Task list ObjectId string." },
            confirm: { type: "boolean", description: "Must be true to confirm permanent deletion of the full task list." }
          },
          required: ["taskListId", "confirm"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "addContact",
        description: "Create a contact document in MongoDB.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Contact full name." },
            email: { type: "string", description: "Contact email." },
            title: { type: "string", description: "Contact title." },
            reportsTo: {
              type: "object",
              properties: {
                contactId: { type: "string", description: "Manager contact ObjectId." },
                name: { type: "string", description: "Manager name." }
              }
            },
            notes: { type: "string", description: "Optional notes field (long text)." },
            freeText: { type: "string", description: "Optional free text field (long text)." },
            workloadIds: {
              type: "array",
              description: "Optional list of workload references; each item can be a workload ID string or object { workloadId, name }.",
              items: {
                anyOf: [
                  { type: "string" },
                  {
                    type: "object",
                    properties: {
                      workloadId: { type: "string" },
                      id: { type: "string" },
                      name: { type: "string" }
                    }
                  }
                ]
              }
            },
            workloadId: { type: "string", description: "Optional single workload ID alias." }
          },
          required: ["name"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "updateContact",
        description: "Update a MongoDB contact by ObjectId.",
        parameters: {
          type: "object",
          properties: {
            contactId: { type: "string", description: "Contact ObjectId string." },
            name: { type: "string" },
            email: { type: "string" },
            title: { type: "string" },
            reportsTo: {
              type: "object",
              properties: {
                contactId: { type: "string", description: "Manager contact ObjectId." },
                name: { type: "string", description: "Manager name." }
              }
            },
            clearReportsTo: { type: "boolean", description: "Set true to clear reportsTo." },
            notes: { type: "string" },
            freeText: { type: "string" },
            workloadIds: {
              type: "array",
              items: {
                anyOf: [
                  { type: "string" },
                  {
                    type: "object",
                    properties: {
                      workloadId: { type: "string" },
                      id: { type: "string" },
                      name: { type: "string" }
                    }
                  }
                ]
              }
            },
            workloadId: { type: "string", description: "Optional single workload ID alias." }
          },
          required: ["contactId"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "listContacts",
        description: "List contacts from MongoDB.",
        parameters: {
          type: "object",
          properties: {
            email: { type: "string", description: "Optional email filter." },
            limit: { type: "number", description: "Optional max results, default 50." }
          },
          required: []
        }
      }
    },
    {
      type: "function",
      function: {
        name: "getContact",
        description: "Get one MongoDB contact by ObjectId.",
        parameters: {
          type: "object",
          properties: {
            contactId: { type: "string", description: "Contact ObjectId string." }
          },
          required: ["contactId"]
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

function isValidObjectId(value) {
  return typeof value === 'string' && /^[a-fA-F0-9]{24}$/.test(value.trim());
}

function oid(value) {
  return { $oid: value.trim() };
}

function normalizeMongoJson(value) {
  if (Array.isArray(value)) return value.map(normalizeMongoJson);
  if (!value || typeof value !== 'object') return value;
  if (Object.prototype.hasOwnProperty.call(value, '$oid')) return value.$oid;
  if (Object.prototype.hasOwnProperty.call(value, '$date')) {
    if (typeof value.$date === 'string') return value.$date;
    if (value.$date && value.$date.$numberLong) return new Date(Number(value.$date.$numberLong)).toISOString();
  }
  var out = {};
  Object.keys(value).forEach(function(key) {
    out[key] = normalizeMongoJson(value[key]);
  });
  return out;
}

function mongoDataApiRequest(action, payload) {
  try {
    var cfg = getMongoConfig();
    if (!cfg.dataApiBaseUrl) return { error: 'Set MONGO_DATA_API_BASE_URL in Script Properties.' };
    if (!cfg.dataApiKey) return { error: 'Set MONGO_DATA_API_KEY in Script Properties.' };
    if (!cfg.dataSource) return { error: 'Set MONGO_DATA_SOURCE in Script Properties.' };
    if (!cfg.dbName) return { error: 'Set MONGO_DB_NAME in Script Properties.' };

    var base = cfg.dataApiBaseUrl.replace(/\/$/, '');
    var endpoint = base.indexOf('/action/') !== -1 ? base.replace(/\/action\/.*/, '/action/' + action) : base + '/action/' + action;
    var response = UrlFetchApp.fetch(endpoint, {
      method: 'post',
      contentType: 'application/json',
      muteHttpExceptions: true,
      headers: { 'api-key': cfg.dataApiKey },
      payload: JSON.stringify(payload || {})
    });
    var text = response.getContentText();
    var data = text ? JSON.parse(text) : {};
    var status = response.getResponseCode();
    if (status >= 300) {
      var msg = (data && (data.error || data.error_code || data.detail || data.reason)) || ('HTTP ' + status);
      return { error: 'Mongo Data API error: ' + msg, details: data };
    }
    return { ok: true, data: data };
  } catch (err) {
    return { error: err.message || err.toString() };
  }
}

function fetchContactNameById(contactId) {
  var cfg = getMongoConfig();
  var res = mongoDataApiRequest('findOne', {
    dataSource: cfg.dataSource,
    database: cfg.dbName,
    collection: cfg.contactsCollection,
    filter: { _id: oid(contactId) },
    projection: { name: 1 }
  });
  if (res.error) return { error: res.error };
  if (!res.data || !res.data.document) return { error: 'reportsTo contact not found.' };
  var doc = normalizeMongoJson(res.data.document);
  if (!doc.name) return { error: 'reportsTo contact has no name.' };
  return { name: doc.name };
}

function fetchWorkloadNameById(workloadId) {
  var cfg = getMongoConfig();
  var res = mongoDataApiRequest('findOne', {
    dataSource: cfg.dataSource,
    database: cfg.dbName,
    collection: cfg.workloadsCollection,
    filter: { _id: oid(workloadId) },
    projection: { name: 1 }
  });
  if (res.error) return { error: res.error };
  if (!res.data || !res.data.document) return { error: 'workload not found: ' + workloadId };
  var doc = normalizeMongoJson(res.data.document);
  var name = doc && doc.name ? String(doc.name).trim() : '';
  if (!name) return { error: 'workload has no name: ' + workloadId };
  return { name: name };
}

function normalizeWorkloadRefsInput(rawValue) {
  if (rawValue == null) return { value: [] };
  var source = Array.isArray(rawValue) ? rawValue : [rawValue];
  var refs = [];
  var seen = {};
  for (var i = 0; i < source.length; i++) {
    var entry = source[i];
    if (entry == null) continue;
    var workloadId = '';
    var name = '';
    if (typeof entry === 'string') {
      workloadId = String(entry).trim();
    } else if (typeof entry === 'object' && !Array.isArray(entry)) {
      workloadId = String(entry.workloadId || entry.id || '').trim();
      name = entry.name != null ? String(entry.name).trim() : '';
    } else {
      continue;
    }
    if (!workloadId || seen[workloadId]) continue;
    if (!isValidObjectId(workloadId)) {
      return { error: 'workloadId must be a valid ObjectId: ' + workloadId };
    }
    if (!name) {
      var lookup = fetchWorkloadNameById(workloadId);
      if (lookup.error) return { error: lookup.error };
      name = String(lookup.name || '').trim();
    }
    seen[workloadId] = true;
    refs.push({ workloadId: workloadId, name: name || null });
  }
  return { value: refs };
}

function normalizeReportsToInput(reportsTo) {
  if (!reportsTo) return { value: null };
  var managerId = reportsTo.contactId ? String(reportsTo.contactId).trim() : '';
  if (!isValidObjectId(managerId)) {
    return { error: 'reportsTo.contactId must be a valid ObjectId.' };
  }
  var managerName = reportsTo.name ? String(reportsTo.name).trim() : '';
  if (!managerName) {
    var lookup = fetchContactNameById(managerId);
    if (lookup.error) return { error: lookup.error };
    managerName = lookup.name;
  }
  return { value: { contactId: managerId, name: managerName } };
}

function normalizeStatus(value) {
  var allowed = ['open', 'in_progress', 'blocked', 'done'];
  var status = (value || '').toString().trim().toLowerCase();
  if (allowed.indexOf(status) === -1) {
    return { error: 'status must be one of: ' + allowed.join(', ') + '.' };
  }
  return { value: status };
}

function normalizePriority(value) {
  var allowed = ['Priority 1', 'Priority 2', 'Priority 3', 'Priority 4'];
  var raw = (value || '').toString().trim();
  if (allowed.indexOf(raw) === -1) {
    return { error: 'priority must be one of: ' + allowed.join(', ') + '.' };
  }
  return { value: raw };
}

function escapeMongoRegex_(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Matches owner field OR list name (case-insensitive), for lists with null owner but person as name. */
function buildTaskListOwnerOrNameFilter_(owner) {
  var escaped = escapeMongoRegex_(owner);
  return {
    $or: [
      { owner: { $regex: '^' + escaped + '$', $options: 'i' } },
      { name: { $regex: '^' + escaped + '$', $options: 'i' } }
    ]
  };
}

/** Broad keyword filter across list name and owner. */
function buildTaskListQFilter_(q) {
  var escaped = escapeMongoRegex_(q);
  if (!escaped) return {};
  return {
    $or: [
      { name: { $regex: escaped, $options: 'i' } },
      { owner: { $regex: escaped, $options: 'i' } }
    ]
  };
}

function buildTaskTextFilter_(q) {
  var escaped = escapeMongoRegex_(q);
  if (!escaped) return {};
  return { task: { $regex: escaped, $options: 'i' } };
}

function buildTaskLookupFilter_(taskId) {
  var trimmed = String(taskId || '').trim();
  if (!trimmed) return null;
  if (isValidObjectId(trimmed)) {
    return {
      $or: [
        { _id: oid(trimmed) },
        { taskId: trimmed }
      ]
    };
  }
  return { taskId: trimmed };
}

function normalizeTaskForRead_(taskDoc) {
  if (!taskDoc || typeof taskDoc !== 'object') return taskDoc;
  var out = normalizeMongoJson(taskDoc);
  var taskId = out.taskId ? String(out.taskId) : (out._id ? String(out._id) : null);
  return {
    _id: out._id || null,
    taskId: taskId,
    task: out.task ? String(out.task) : '',
    status: out.status ? String(out.status) : 'open',
    priority: out.priority ? String(out.priority) : null,
    dueDate: out.dueDate ? String(out.dueDate) : null,
    person: out.person && typeof out.person === 'object' ? out.person : null,
    accountId: out.accountId ? String(out.accountId) : null,
    workloadId: out.workloadId ? String(out.workloadId) : null,
    taskListId: out.taskListId ? String(out.taskListId) : null,
    taskListName: out.taskListName ? String(out.taskListName) : null,
    createdAt: out.createdAt ? String(out.createdAt) : null,
    updatedAt: out.updatedAt ? String(out.updatedAt) : null
  };
}

function listTasksByTaskListIds_(taskListIds) {
  var cfg = getMongoConfig();
  var ids = Array.isArray(taskListIds) ? taskListIds.map(function(id) { return String(id || '').trim(); }).filter(Boolean) : [];
  if (!ids.length) return { byListId: {} };
  var res = mongoDataApiRequest('find', {
    dataSource: cfg.dataSource,
    database: cfg.dbName,
    collection: cfg.tasksCollection,
    filter: { taskListId: { $in: ids } },
    sort: { updatedAt: -1 },
    limit: 5000
  });
  if (res.error) return { error: res.error };
  var docs = normalizeMongoJson((res.data && res.data.documents) || []);
  var byListId = {};
  for (var i = 0; i < ids.length; i++) byListId[ids[i]] = [];
  for (var j = 0; j < docs.length; j++) {
    var row = docs[j];
    var listId = row && row.taskListId ? String(row.taskListId).trim() : '';
    if (!listId) continue;
    if (!byListId[listId]) byListId[listId] = [];
    byListId[listId].push(normalizeTaskForRead_(row));
  }
  return { byListId: byListId };
}

function createTaskList(args) {
  try {
    var cfg = getMongoConfig();
    var name = (args.name || '').trim();
    if (!name) return { error: 'name is required.' };
    var owner = (args.owner || '').trim();
    var now = new Date().toISOString();
    var doc = {
      name: name,
      owner: owner || null,
      createdAt: now,
      updatedAt: now
    };
    var res = mongoDataApiRequest('insertOne', {
      dataSource: cfg.dataSource,
      database: cfg.dbName,
      collection: cfg.taskListsCollection,
      document: doc
    });
    if (res.error) return { error: res.error };
    var inserted = normalizeMongoJson(res.data.insertedId);
    return { success: true, taskListId: inserted, taskList: normalizeMongoJson(doc) };
  } catch (err) {
    return { error: err.message || err.toString() };
  }
}

function updateTaskList(args) {
  try {
    var cfg = getMongoConfig();
    var taskListId = (args.taskListId || '').trim();
    if (!isValidObjectId(taskListId)) return { error: 'taskListId must be a valid ObjectId.' };

    var hasName = Object.prototype.hasOwnProperty.call(args, 'name');
    var hasOwner = Object.prototype.hasOwnProperty.call(args, 'owner');
    if (!hasName && !hasOwner) return { error: 'Provide name and/or owner to update.' };

    var existingRes = mongoDataApiRequest('findOne', {
      dataSource: cfg.dataSource,
      database: cfg.dbName,
      collection: cfg.taskListsCollection,
      filter: { _id: oid(taskListId) }
    });
    if (existingRes.error) return { error: existingRes.error };
    if (!existingRes.data || !existingRes.data.document) return { error: 'Task list not found.' };

    var nowIso = new Date().toISOString();
    var setFields = { updatedAt: nowIso };

    if (hasName) {
      var nextName = String(args.name || '').trim();
      if (!nextName) return { error: 'name cannot be empty when provided.' };
      setFields.name = nextName;
    }
    if (hasOwner) {
      var o = args.owner;
      setFields.owner = o == null || String(o).trim() === '' ? null : String(o).trim();
    }

    var updateRes = mongoDataApiRequest('updateOne', {
      dataSource: cfg.dataSource,
      database: cfg.dbName,
      collection: cfg.taskListsCollection,
      filter: { _id: oid(taskListId) },
      update: { $set: setFields }
    });
    if (updateRes.error) return { error: updateRes.error };

    if (Object.prototype.hasOwnProperty.call(setFields, 'name')) {
      var tasksSyncRes = mongoDataApiRequest('updateMany', {
        dataSource: cfg.dataSource,
        database: cfg.dbName,
        collection: cfg.tasksCollection,
        filter: { taskListId: taskListId },
        update: { $set: { taskListName: setFields.name, updatedAt: nowIso } }
      });
      if (tasksSyncRes.error) return { error: tasksSyncRes.error };
    }

    var outRes = mongoDataApiRequest('findOne', {
      dataSource: cfg.dataSource,
      database: cfg.dbName,
      collection: cfg.taskListsCollection,
      filter: { _id: oid(taskListId) }
    });
    if (outRes.error) return { error: outRes.error };
    var row = normalizeMongoJson(outRes.data.document);
    return {
      success: true,
      taskListId: taskListId,
      taskList: {
        _id: row._id,
        name: row.name ? String(row.name) : '',
        owner: row.owner != null && String(row.owner).trim() ? String(row.owner).trim() : null,
        createdAt: row.createdAt || null,
        updatedAt: row.updatedAt || null
      }
    };
  } catch (err) {
    return { error: err.message || err.toString() };
  }
}

function getTaskList(args) {
  try {
    var cfg = getMongoConfig();
    var taskListId = (args.taskListId || '').trim();
    if (!isValidObjectId(taskListId)) return { error: 'taskListId must be a valid ObjectId.' };
    var res = mongoDataApiRequest('findOne', {
      dataSource: cfg.dataSource,
      database: cfg.dbName,
      collection: cfg.taskListsCollection,
      filter: { _id: oid(taskListId) }
    });
    if (res.error) return { error: res.error };
    if (!res.data || !res.data.document) return { error: 'Task list not found.' };
    var listDoc = normalizeMongoJson(res.data.document);
    var tasksRes = listTasksByTaskListIds_([listDoc._id]);
    if (tasksRes.error) return { error: tasksRes.error };
    return { taskList: Object.assign({}, listDoc, { tasks: tasksRes.byListId[listDoc._id] || [] }) };
  } catch (err) {
    return { error: err.message || err.toString() };
  }
}

function listTaskLists(args) {
  try {
    var cfg = getMongoConfig();
    var owner = args.owner ? String(args.owner).trim() : '';
    var q = args.q ? String(args.q).trim() : '';
    var limit = Number(args.limit || 25);
    if (!isFinite(limit) || limit < 1) limit = 25;
    if (limit > 100) limit = 100;
    var filter = {};
    if (owner && q) {
      filter.$and = [buildTaskListOwnerOrNameFilter_(owner), buildTaskListQFilter_(q)];
    } else if (owner) {
      filter = buildTaskListOwnerOrNameFilter_(owner);
    } else if (q) {
      filter = buildTaskListQFilter_(q);
    }
    var res = mongoDataApiRequest('find', {
      dataSource: cfg.dataSource,
      database: cfg.dbName,
      collection: cfg.taskListsCollection,
      filter: filter,
      projection: { name: 1, owner: 1, createdAt: 1, updatedAt: 1 },
      sort: { updatedAt: -1 },
      limit: Math.max(limit, 250)
    });
    if (res.error) return { error: res.error };
    var docs = normalizeMongoJson((res.data && res.data.documents) || []);
    if (q) {
      var taskRes = mongoDataApiRequest('find', {
        dataSource: cfg.dataSource,
        database: cfg.dbName,
        collection: cfg.tasksCollection,
        filter: buildTaskTextFilter_(q),
        projection: { taskListId: 1 },
        limit: 1000
      });
      if (taskRes.error) return { error: taskRes.error };
      var taskDocs = normalizeMongoJson((taskRes.data && taskRes.data.documents) || []);
      var listIdHitSet = {};
      for (var t = 0; t < taskDocs.length; t++) {
        var listIdHit = taskDocs[t] && taskDocs[t].taskListId ? String(taskDocs[t].taskListId).trim() : '';
        if (listIdHit) listIdHitSet[listIdHit] = true;
      }
      if (Object.keys(listIdHitSet).length) {
        for (var d = 0; d < docs.length; d++) {
          var existingId = docs[d] && docs[d]._id ? String(docs[d]._id) : '';
          if (existingId) listIdHitSet[existingId] = true;
        }
        docs = docs.filter(function(doc) {
          var id = doc && doc._id ? String(doc._id) : '';
          return !!listIdHitSet[id];
        });
        if (!docs.length) {
          var ids = Object.keys(listIdHitSet).filter(function(id) { return isValidObjectId(id); }).slice(0, limit);
          if (ids.length) {
            var idRes = mongoDataApiRequest('find', {
              dataSource: cfg.dataSource,
              database: cfg.dbName,
              collection: cfg.taskListsCollection,
              filter: { _id: { $in: ids.map(function(id) { return oid(id); }) } },
              projection: { name: 1, owner: 1, createdAt: 1, updatedAt: 1 },
              sort: { updatedAt: -1 },
              limit: limit
            });
            if (idRes.error) return { error: idRes.error };
            docs = normalizeMongoJson((idRes.data && idRes.data.documents) || []);
          }
        }
      }
    }
    var listIds = docs.map(function(doc) { return String(doc && doc._id ? doc._id : ''); }).filter(Boolean);
    var tasksByListRes = listTasksByTaskListIds_(listIds);
    if (tasksByListRes.error) return { error: tasksByListRes.error };
    var tasksByList = tasksByListRes.byListId || {};
    var maxPreview = 50;
    var lists = docs.map(function(doc) {
      var rawTasks = Array.isArray(tasksByList[doc._id]) ? tasksByList[doc._id] : [];
      var tasksPreview = [];
      for (var ti = 0; ti < rawTasks.length && ti < maxPreview; ti++) {
        var tr = rawTasks[ti];
        tasksPreview.push({
          taskId: tr.taskId,
          task: tr.task,
          status: tr.status
        });
      }
      return {
        _id: doc._id,
        name: doc.name,
        owner: doc.owner || null,
        taskCount: rawTasks.length,
        tasksPreview: tasksPreview,
        tasksPreviewTruncated: rawTasks.length > maxPreview,
        createdAt: doc.createdAt || null,
        updatedAt: doc.updatedAt || null
      };
    }).slice(0, limit);
    return { taskLists: lists };
  } catch (err) {
    return { error: err.message || err.toString() };
  }
}

function deleteTaskList(args) {
  try {
    var cfg = getMongoConfig();
    var taskListId = (args.taskListId || '').trim();
    if (!isValidObjectId(taskListId)) return { error: 'taskListId must be a valid ObjectId.' };
    if (args.confirm !== true) {
      return { error: 'Confirmation required: re-run deleteTaskList with confirm=true after the user explicitly confirms permanent deletion.' };
    }
    var res = mongoDataApiRequest('deleteOne', {
      dataSource: cfg.dataSource,
      database: cfg.dbName,
      collection: cfg.taskListsCollection,
      filter: { _id: oid(taskListId) }
    });
    if (res.error) return { error: res.error };
    var deleted = normalizeMongoJson(res.data && res.data.deletedCount);
    if (!deleted) return { error: 'Task list not found.' };
    var tasksDeleteRes = mongoDataApiRequest('deleteMany', {
      dataSource: cfg.dataSource,
      database: cfg.dbName,
      collection: cfg.tasksCollection,
      filter: { taskListId: taskListId }
    });
    if (tasksDeleteRes.error) return { error: tasksDeleteRes.error };
    return { success: true, taskListId: taskListId, deleted: true };
  } catch (err) {
    return { error: err.message || err.toString() };
  }
}

function addTaskToList(args) {
  try {
    var cfg = getMongoConfig();
    var taskListId = (args.taskListId || '').trim();
    if (!isValidObjectId(taskListId)) return { error: 'taskListId must be a valid ObjectId.' };
    var task = (args.task || '').trim();
    if (!task) return { error: 'task is required.' };
    var statusArg = args.status == null ? 'open' : String(args.status).trim();
    if (!statusArg) statusArg = 'open';
    var statusResult = normalizeStatus(statusArg);
    if (statusResult.error) return { error: statusResult.error };
    var person = args.person || {};
    var personName = (person.name || '').trim();
    var personTitle = (person.title || '').trim();
    var personRole = (person.role || '').trim();

    var getRes = getTaskList({ taskListId: taskListId });
    if (getRes.error) return getRes;
    var listDoc = getRes.taskList || {};
    var now = new Date().toISOString();

    var entry = {
      taskId: Utilities.getUuid(),
      taskListId: taskListId,
      taskListName: listDoc.name ? String(listDoc.name) : null,
      task: task,
      status: statusResult.value,
      createdAt: now,
      updatedAt: now
    };
    if (args.priority != null && String(args.priority).trim()) {
      var priorityResult = normalizePriority(args.priority);
      if (priorityResult.error) return { error: priorityResult.error };
      entry.priority = priorityResult.value;
    }
    if (personName || personTitle || personRole) {
      entry.person = { name: personName, title: personTitle, role: personRole };
    }
    if (args.dueDate) entry.dueDate = String(args.dueDate).trim();
    if (args.accountId) entry.accountId = String(args.accountId).trim();
    if (args.workloadId) entry.workloadId = String(args.workloadId).trim();
    var insertRes = mongoDataApiRequest('insertOne', {
      dataSource: cfg.dataSource,
      database: cfg.dbName,
      collection: cfg.tasksCollection,
      document: entry
    });
    if (insertRes.error) return { error: insertRes.error };
    var insertedTaskId = normalizeMongoJson(insertRes.data && insertRes.data.insertedId);
    if (insertedTaskId && !entry.taskId) entry.taskId = insertedTaskId;

    var updateRes = mongoDataApiRequest('updateOne', {
      dataSource: cfg.dataSource,
      database: cfg.dbName,
      collection: cfg.taskListsCollection,
      filter: { _id: oid(taskListId) },
      update: { $set: { updatedAt: new Date().toISOString() } }
    });
    if (updateRes.error) return { error: updateRes.error };
    return { success: true, taskListId: taskListId, addedTask: normalizeTaskForRead_(entry) };
  } catch (err) {
    return { error: err.message || err.toString() };
  }
}

function updateTaskInList(args) {
  try {
    var cfg = getMongoConfig();
    var taskListId = (args.taskListId || '').trim();
    var taskId = (args.taskId || '').trim();
    if (!isValidObjectId(taskListId)) return { error: 'taskListId must be a valid ObjectId.' };
    if (!taskId) return { error: 'taskId is required.' };

    var listRes = mongoDataApiRequest('findOne', {
      dataSource: cfg.dataSource,
      database: cfg.dbName,
      collection: cfg.taskListsCollection,
      filter: { _id: oid(taskListId) },
      projection: { _id: 1, name: 1 }
    });
    if (listRes.error) return { error: listRes.error };
    if (!listRes.data || !listRes.data.document) return { error: 'Task list not found.' };
    var listDoc = normalizeMongoJson(listRes.data.document);

    var lookupFilter = buildTaskLookupFilter_(taskId);
    var taskRes = mongoDataApiRequest('findOne', {
      dataSource: cfg.dataSource,
      database: cfg.dbName,
      collection: cfg.tasksCollection,
      filter: Object.assign({ taskListId: taskListId }, lookupFilter || {})
    });
    if (taskRes.error) return { error: taskRes.error };
    if (!taskRes.data || !taskRes.data.document) return { error: 'Task not found in task list.' };

    var changed = false;
    var current = normalizeMongoJson(taskRes.data.document);
    if (args.task != null) {
      current.task = String(args.task).trim();
      changed = true;
    }
    if (args.status != null) {
      var statusResult = normalizeStatus(args.status);
      if (statusResult.error) return { error: statusResult.error };
      current.status = statusResult.value;
      changed = true;
    }
    if (Object.prototype.hasOwnProperty.call(args, 'priority')) {
      var priorityRaw = args.priority == null ? '' : String(args.priority).trim();
      if (priorityRaw) {
        var priorityResult = normalizePriority(priorityRaw);
        if (priorityResult.error) return { error: priorityResult.error };
        current.priority = priorityResult.value;
      } else {
        delete current.priority;
      }
      changed = true;
    }
    if (Object.prototype.hasOwnProperty.call(args, 'dueDate')) {
      var dueDate = args.dueDate == null ? '' : String(args.dueDate).trim();
      if (dueDate) current.dueDate = dueDate;
      else delete current.dueDate;
      changed = true;
    }
    if (args.person && typeof args.person === 'object') {
      var nextPerson = Object.assign({}, current.person || {});
      if (args.person.name != null) nextPerson.name = String(args.person.name).trim();
      if (args.person.title != null) nextPerson.title = String(args.person.title).trim();
      if (args.person.role != null) nextPerson.role = String(args.person.role).trim();
      current.person = nextPerson;
      changed = true;
    }
    if (args.accountId != null) {
      var nextAccountId = String(args.accountId).trim();
      if (nextAccountId) current.accountId = nextAccountId;
      else delete current.accountId;
      changed = true;
    }
    if (args.workloadId != null) {
      var nextWorkloadId = String(args.workloadId).trim();
      if (nextWorkloadId) current.workloadId = nextWorkloadId;
      else delete current.workloadId;
      changed = true;
    }
    if (!changed) return { error: 'No updates provided for task.' };

    current.taskListId = taskListId;
    current.taskListName = listDoc.name ? String(listDoc.name) : null;
    if (!current.taskId && current._id) current.taskId = String(current._id);
    current.updatedAt = new Date().toISOString();
    var updateRes = mongoDataApiRequest('updateOne', {
      dataSource: cfg.dataSource,
      database: cfg.dbName,
      collection: cfg.tasksCollection,
      filter: Object.assign({ taskListId: taskListId }, lookupFilter || {}),
      update: { $set: current }
    });
    if (updateRes.error) return { error: updateRes.error };
    var touchListRes = mongoDataApiRequest('updateOne', {
      dataSource: cfg.dataSource,
      database: cfg.dbName,
      collection: cfg.taskListsCollection,
      filter: { _id: oid(taskListId) },
      update: { $set: { updatedAt: new Date().toISOString() } }
    });
    if (touchListRes.error) return { error: touchListRes.error };
    return { success: true, taskListId: taskListId, task: normalizeTaskForRead_(current) };
  } catch (err) {
    return { error: err.message || err.toString() };
  }
}

function addContact(args) {
  try {
    var cfg = getMongoConfig();
    var name = (args.name || '').trim();
    var email = (args.email || '').trim();
    var title = (args.title || '').trim();
    if (!name) return { error: 'name is required.' };

    var reportsToData = normalizeReportsToInput(args.reportsTo);
    if (reportsToData.error) return { error: reportsToData.error };

    var workloadInput = (args.workloadIds != null) ? args.workloadIds : args.workloadId;
    var workloadRefs = normalizeWorkloadRefsInput(workloadInput);
    if (workloadRefs.error) return { error: workloadRefs.error };
    var now = new Date().toISOString();
    var doc = {
      name: name,
      email: email || null,
      title: title || null,
      reportsTo: reportsToData.value,
      notes: args.notes != null ? String(args.notes) : null,
      freeText: args.freeText != null ? String(args.freeText) : null,
      workloadIds: workloadRefs.value,
      createdAt: now,
      updatedAt: now
    };

    var res = mongoDataApiRequest('insertOne', {
      dataSource: cfg.dataSource,
      database: cfg.dbName,
      collection: cfg.contactsCollection,
      document: doc
    });
    if (res.error) return { error: res.error };
    return {
      success: true,
      contactId: normalizeMongoJson(res.data.insertedId),
      contact: normalizeMongoJson(doc)
    };
  } catch (err) {
    return { error: err.message || err.toString() };
  }
}

function getContact(args) {
  try {
    var cfg = getMongoConfig();
    var contactId = (args.contactId || '').trim();
    if (!isValidObjectId(contactId)) return { error: 'contactId must be a valid ObjectId.' };
    var res = mongoDataApiRequest('findOne', {
      dataSource: cfg.dataSource,
      database: cfg.dbName,
      collection: cfg.contactsCollection,
      filter: { _id: oid(contactId) }
    });
    if (res.error) return { error: res.error };
    if (!res.data || !res.data.document) return { error: 'Contact not found.' };
    return { contact: normalizeMongoJson(res.data.document) };
  } catch (err) {
    return { error: err.message || err.toString() };
  }
}

function listContacts(args) {
  try {
    var cfg = getMongoConfig();
    var email = args.email ? String(args.email).trim() : '';
    var limit = Number(args.limit || 50);
    if (!isFinite(limit) || limit < 1) limit = 50;
    if (limit > 200) limit = 200;
    var filter = {};
    if (email) filter.email = email;
    var res = mongoDataApiRequest('find', {
      dataSource: cfg.dataSource,
      database: cfg.dbName,
      collection: cfg.contactsCollection,
      filter: filter,
      projection: {
        name: 1,
        email: 1,
        title: 1,
        reportsTo: 1,
        workloadIds: 1,
        updatedAt: 1,
        createdAt: 1
      },
      sort: { updatedAt: -1 },
      limit: limit
    });
    if (res.error) return { error: res.error };
    return { contacts: normalizeMongoJson((res.data && res.data.documents) || []) };
  } catch (err) {
    return { error: err.message || err.toString() };
  }
}

function updateContact(args) {
  try {
    var cfg = getMongoConfig();
    var contactId = (args.contactId || '').trim();
    if (!isValidObjectId(contactId)) return { error: 'contactId must be a valid ObjectId.' };

    var setFields = { updatedAt: new Date().toISOString() };
    if (args.name != null) setFields.name = String(args.name).trim();
    if (args.email != null) setFields.email = String(args.email).trim();
    if (args.title != null) setFields.title = String(args.title).trim();
    if (args.notes != null) setFields.notes = String(args.notes);
    if (args.freeText != null) setFields.freeText = String(args.freeText);
    if (args.workloadIds != null || args.workloadId != null) {
      var workloadInput = (args.workloadIds != null) ? args.workloadIds : args.workloadId;
      var workloadRefs = normalizeWorkloadRefsInput(workloadInput);
      if (workloadRefs.error) return { error: workloadRefs.error };
      setFields.workloadIds = workloadRefs.value;
    }
    if (args.clearReportsTo === true) {
      setFields.reportsTo = null;
    } else if (args.reportsTo != null) {
      var reportsToData = normalizeReportsToInput(args.reportsTo);
      if (reportsToData.error) return { error: reportsToData.error };
      setFields.reportsTo = reportsToData.value;
    }

    if (Object.keys(setFields).length === 1) return { error: 'No contact fields supplied to update.' };
    var res = mongoDataApiRequest('updateOne', {
      dataSource: cfg.dataSource,
      database: cfg.dbName,
      collection: cfg.contactsCollection,
      filter: { _id: oid(contactId) },
      update: { $set: setFields }
    });
    if (res.error) return { error: res.error };
    return { success: true, contactId: contactId, updatedFields: setFields };
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
  throw new Error('Deprecated in API-only mode. Route chat requests through the Node API.');
}

/**
 * Serves the HTML page when the URL is visited in a browser.
 */
function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({
    ok: false,
    error: 'API-only deployment. Use POST actions from the Node backend.'
  })).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Triggered by the HTML form. 
 * Merges document context + prompt and runs the Agent Loop.
 */
function processForm(docUrl, extraPrompt) {
  throw new Error('Deprecated in API-only mode. Route workflow requests through the Node API.');
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
  throw new Error('Deprecated in API-only mode. Route workflow requests through the Node API.');
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
