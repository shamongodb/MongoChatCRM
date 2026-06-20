import {
  authHeaders as buildAuthHeaders,
  buildAuthFailureMessage,
  clearAuthState,
  getAuthState,
  isAuthenticated,
  loadStoredAuthState
} from './auth.js';

const config = window.__WEB_UX_CONFIG__ || {};

const state = {
  apiBaseUrl: String(config.apiBaseUrl || '').trim().replace(/\/+$/, ''),
  currentView: 'home',
  currentConversationId: null,
  chatMessages: [],
  chatSessions: [],
  voiceTurnExpectTts: false
};

const RESPONSE_MODE_CHAT_DEFAULT = 'chat_default';
const RESPONSE_MODE_VOICE_CONVERSATIONAL = 'voice_conversational';
const RESPONSE_MODE_VOICE_WHIMSICAL = 'voice_whimsical';
const VOICE_STYLE_TAG_PREFIX = /^\s*\[(voice_friendly|voice_conversational|voice_whimsical|whimsical)\]\s*/i;
const TASK_LIST_FILTERS_STORAGE_KEY = 'webUxTaskListHiddenIds';

let voicePttRecording = false;
let voiceShortcutHeld = false;
let voiceMicPointerHeld = false;
let voiceCancelStart = false;
let voiceMediaStream = null;
let voiceMediaRecorder = null;
let voiceChunks = [];
const CONTACT_DEFAULT_TABLE_COLUMNS = Object.freeze(['name', 'email', 'title']);
const INITIATIVE_WORKLOAD_PALETTES = Object.freeze([
  { background: '#dbeafe', borderColor: '#60a5fa', color: '#0c4a6e' },
  { background: '#fef3c7', borderColor: '#fbbf24', color: '#78350f' },
  { background: '#d1fae5', borderColor: '#34d399', color: '#064e3b' },
  { background: '#fce7f3', borderColor: '#f472b6', color: '#831843' },
  { background: '#e9d5ff', borderColor: '#a78bfa', color: '#4c1d95' },
  { background: '#cffafe', borderColor: '#22d3ee', color: '#164e63' },
  { background: '#ffedd5', borderColor: '#fb923c', color: '#7c2d12' },
  { background: '#ecfccb', borderColor: '#84cc16', color: '#365314' }
]);
const contactsViewState = {
  mode: 'hierarchy',
  selectedAccounts: new Set(),
  selectedColumns: new Set(CONTACT_DEFAULT_TABLE_COLUMNS),
  knownAccounts: new Set()
};
const taskListFiltersState = {
  hiddenListIds: new Set()
};

const CONTACT_CANONICAL_LABELS = {
  linkedIn: 'LinkedIn',
  imageUrl: 'ImageURL',
  timeZone: 'Time Zone'
};

const CONTACT_FIELD_ALIASES = {
  preferredName: ['PreferredName'],
  pronouns: ['Pronouns'],
  department: ['Department'],
  phone: ['Phone'],
  mobile: ['Mobile'],
  location: ['Location'],
  timeZone: ['TimeZone', 'timezone'],
  linkedIn: ['LinkedIn', 'linkedin', 'linkedInUrl', 'linkedinUrl'],
  imageUrl: ['ImageURL', 'imageURL', 'profileImageUrl', 'linkedinImageUrl', 'linkedInImageUrl'],
  website: ['Website'],
  relationshipStatus: ['RelationshipStatus'],
  lastContactDate: ['LastContactDate'],
  nextFollowUpDate: ['NextFollowUpDate'],
  owner: ['Owner'],
  tags: ['Tags'],
  source: ['Source'],
  notes: ['Notes'],
  freeText: ['FreeText'],
  reportsTo: ['ReportsTo']
};

const CONTACT_EXTRA_FIELD_ORDER = [
  'imageUrl',
  'preferredName',
  'pronouns',
  'department',
  'phone',
  'mobile',
  'location',
  'timeZone',
  'website',
  'relationshipStatus',
  'lastContactDate',
  'nextFollowUpDate',
  'owner',
  'tags',
  'source',
  'reportsTo',
  'notes',
  'freeText'
];
const MILESTONE_STATUS_ORDER = ['On Target', 'Delayed', 'Completed'];

const viewTitleEl = document.getElementById('viewTitle');
const cardsContainerEl = document.getElementById('cardsContainer');
const navIconsEl = document.getElementById('navIcons');
const appShellEl = document.querySelector('.app-shell');
const MOBILE_MQ = window.matchMedia('(max-width: 768px)');
const chatSessionListEl = document.getElementById('chatSessionList');
const chatMessagesEl = document.getElementById('chatMessages');
const chatInputEl = document.getElementById('chatInput');
const chatInputWrapEl = document.querySelector('.chat-input-wrap');
const chatMicBtnEl = document.getElementById('chatMicBtn');
const chatSendBtnEl = document.getElementById('chatSendBtn');
const chatStatusEl = document.getElementById('chatStatus');
const newChatBtnEl = document.getElementById('newChatBtn');
const authSignedInEl = document.getElementById('authSignedIn');
const authUserEmailEl = document.getElementById('authUserEmail');
const signOutBtnEl = document.getElementById('signOutBtn');

function isMobileLayout() {
  return MOBILE_MQ.matches;
}

function setMobileChatOpen(open) {
  appShellEl?.classList.toggle('is-chat-open', open);
  const chatBtn = navIconsEl.querySelector('[data-view="chat"]');
  chatBtn?.classList.toggle('active', open);
  if (open) {
    navIconsEl.querySelectorAll('.icon-btn:not([data-view="chat"])').forEach((btn) => {
      btn.classList.remove('active');
    });
  }
}

function updateChatInputPlaceholder() {
  if (!chatInputEl) return;
  chatInputEl.placeholder = isMobileLayout()
    ? 'Message (hold mic to speak)'
    : 'Message (hold mic or ⌘⇧1 to speak)';
}

function isVoiceInputSupported() {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== 'undefined'
  );
}

function updateVoiceRecordingUi(isRecording) {
  chatMicBtnEl?.classList.toggle('recording', isRecording);
  chatInputWrapEl?.classList.toggle('is-recording', isRecording);
  if (chatMicBtnEl) {
    chatMicBtnEl.setAttribute('aria-pressed', isRecording ? 'true' : 'false');
    chatMicBtnEl.setAttribute('aria-label', isRecording ? 'Recording…' : 'Hold to speak');
  }
  if (chatInputEl) {
    chatInputEl.disabled = isRecording;
  }
}

function setStatus(text) {
  chatStatusEl.textContent = text || '';
}

function makeId(prefix) {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function ensureSignedIn() {
  if (!isAuthenticated()) {
    throw new Error('Sign in with Google to continue.');
  }
}

function throwIfApiError(res, data) {
  if (res.ok && data.ok !== false) return;
  const authMsg = buildAuthFailureMessage(res, data);
  if (authMsg) {
    clearAuthState();
    updateAuthUi();
    throw new Error(authMsg);
  }
  throw new Error(data.error || `HTTP ${res.status}`);
}

function authHeaders(extraHeaders = {}) {
  return buildAuthHeaders(extraHeaders);
}

function updateAuthUi() {
  const authState = getAuthState();
  const signedIn = Boolean(authState.authToken && authState.userId);
  if (authSignedInEl) authSignedInEl.hidden = !signedIn;
  if (authUserEmailEl) {
    authUserEmailEl.textContent = signedIn ? String(authState.authUser?.email || authState.userId || '') : '';
  }
}

function loadTaskListFilterState() {
  try {
    const raw = localStorage.getItem(TASK_LIST_FILTERS_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    taskListFiltersState.hiddenListIds = new Set(
      parsed
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    );
  } catch (_) {
    taskListFiltersState.hiddenListIds = new Set();
  }
}

function saveTaskListFilterState() {
  try {
    localStorage.setItem(TASK_LIST_FILTERS_STORAGE_KEY, JSON.stringify(Array.from(taskListFiltersState.hiddenListIds)));
  } catch (_) {
    // Ignore storage write failures (e.g. privacy mode).
  }
}

function setTaskListVisibility(taskListId, isVisible) {
  const listId = String(taskListId || '').trim();
  if (!listId) return;
  if (isVisible) taskListFiltersState.hiddenListIds.delete(listId);
  else taskListFiltersState.hiddenListIds.add(listId);
  saveTaskListFilterState();
}

function escapeCssAttrValue(value) {
  const text = String(value == null ? '' : value);
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(text);
  }
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text == null ? '' : String(text);
  return div.innerHTML;
}

function initiativeWorkloadPillInlineStyle(index) {
  const p = INITIATIVE_WORKLOAD_PALETTES[index % INITIATIVE_WORKLOAD_PALETTES.length];
  return `background:${p.background};border:1px solid ${p.borderColor};color:${p.color}`;
}

function summarize(text, maxLen = 140) {
  const value = text == null ? '' : String(text).trim();
  if (!value) return '';
  if (value.length <= maxLen) return value;
  return `${value.slice(0, Math.max(1, maxLen - 3))}...`;
}

function parseOutgoingChatText(rawText, options = {}) {
  const expectVoiceTts = !!options.expectVoiceTts;
  let text = String(rawText == null ? '' : rawText);
  let responseMode = expectVoiceTts ? RESPONSE_MODE_VOICE_CONVERSATIONAL : RESPONSE_MODE_CHAT_DEFAULT;
  const tagged = text.match(VOICE_STYLE_TAG_PREFIX);
  if (tagged) {
    text = text.slice(tagged[0].length);
    const tagName = String(tagged[1] || '').trim().toLowerCase();
    responseMode = tagName === 'voice_whimsical' || tagName === 'whimsical'
      ? RESPONSE_MODE_VOICE_WHIMSICAL
      : RESPONSE_MODE_VOICE_CONVERSATIONAL;
  }
  return {
    text: text.trim(),
    responseMode
  };
}

function isConversationIdLike(value, conversationId = '') {
  const text = String(value || '').trim();
  const id = String(conversationId || '').trim();
  if (!text) return false;
  if (id && text === id) return true;
  return /^conv[_-]/i.test(text);
}

function summarizeWords(text, minWords = 2, maxWords = 3) {
  const clean = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return '';
  const words = clean
    .split(' ')
    .map((word) => word.replace(/^[^\w]+|[^\w]+$/g, ''))
    .filter(Boolean);
  if (!words.length) return '';
  const takeCount = Math.min(maxWords, Math.max(minWords, words.length >= maxWords ? maxWords : words.length));
  return words.slice(0, takeCount).join(' ');
}

function formatContactUpdatedAt(updatedAt) {
  if (!updatedAt) return 'No update time';
  const updatedDate = new Date(updatedAt);
  if (Number.isNaN(updatedDate.getTime())) return 'No update time';
  const ageMs = Date.now() - updatedDate.getTime();
  const oneDayMs = 24 * 60 * 60 * 1000;
  if (ageMs >= 0 && ageMs < oneDayMs) {
    return `Updated ${updatedDate.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }
  return `Updated ${updatedDate.toLocaleDateString()}`;
}

function formatTaskUpdatedAt(updatedAt) {
  if (!updatedAt) return 'No update time';
  const updatedDate = new Date(updatedAt);
  if (Number.isNaN(updatedDate.getTime())) return 'No update time';
  const ageMs = Date.now() - updatedDate.getTime();
  const oneDayMs = 24 * 60 * 60 * 1000;
  if (ageMs >= 0 && ageMs < oneDayMs) {
    return `Updated ${updatedDate.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }
  return `Updated ${updatedDate.toLocaleDateString()}`;
}

function formatTaskDueDate(dueDate) {
  if (!dueDate) return '';
  const d = new Date(dueDate);
  if (Number.isNaN(d.getTime())) return String(dueDate).trim();
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
}

function formatWorkloadUpdatedAt(updatedAt) {
  if (!updatedAt) return 'No update time';
  const updatedDate = new Date(updatedAt);
  if (Number.isNaN(updatedDate.getTime())) return 'No update time';
  const ageMs = Date.now() - updatedDate.getTime();
  const oneDayMs = 24 * 60 * 60 * 1000;
  if (ageMs >= 0 && ageMs < oneDayMs) {
    return `Updated ${updatedDate.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }
  return `Updated ${updatedDate.toLocaleDateString()}`;
}

function getFirstDefinedValue(row, keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(row || {}, key)) return row[key];
  }
  return undefined;
}

function parseNumericValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value == null ? '' : value).trim();
  if (!text) return null;
  const normalized = text.replace(/[$,\s]/g, '').replace(/usd/ig, '');
  const suffixMatch = normalized.match(/^(-?\d+(?:\.\d+)?)([kKmM])$/);
  if (suffixMatch) {
    const base = Number(suffixMatch[1]);
    if (!Number.isFinite(base)) return null;
    return base * (suffixMatch[2].toLowerCase() === 'm' ? 1000000 : 1000);
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function formatArrValue(value) {
  const numeric = parseNumericValue(value);
  if (numeric == null) return '';
  const abs = Math.abs(numeric);
  if (abs > 9999) {
    const compact = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: 'USD',
      notation: 'compact',
      compactDisplay: 'short',
      maximumFractionDigits: 1
    }).format(numeric);
    return compact.replace(/\.0(?=[A-Za-z])/g, '').replace(/K\b/g, 'k');
  }
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0
  }).format(numeric);
}

function parseMilestoneDateValue(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const monthMatch = text.match(/^(\d{4})-(\d{2})$/);
  if (monthMatch) {
    const year = Number(monthMatch[1]);
    const month = Number(monthMatch[2]);
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return null;
    return new Date(Date.UTC(year, month - 1, 1));
  }
  const dayMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dayMatch) {
    const year = Number(dayMatch[1]);
    const month = Number(dayMatch[2]);
    const day = Number(dayMatch[3]);
    const candidate = new Date(Date.UTC(year, month - 1, day));
    if (
      candidate.getUTCFullYear() !== year
      || candidate.getUTCMonth() !== month - 1
      || candidate.getUTCDate() !== day
    ) {
      return null;
    }
    return candidate;
  }
  const monthDayOnly = text.match(/^(\d{1,2})[-/](\d{1,2})$/);
  if (monthDayOnly) {
    const month = Number(monthDayOnly[1]);
    const day = Number(monthDayOnly[2]);
    const candidate = new Date(Date.UTC(currentYear, month - 1, day));
    if (
      !Number.isInteger(month)
      || !Number.isInteger(day)
      || month < 1
      || month > 12
      || candidate.getUTCMonth() !== month - 1
      || candidate.getUTCDate() !== day
    ) {
      return null;
    }
    return candidate;
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  const hasExplicitYear = /\b\d{4}\b/.test(text);
  const targetYear = hasExplicitYear ? parsed.getUTCFullYear() : currentYear;
  return new Date(Date.UTC(targetYear, parsed.getUTCMonth(), parsed.getUTCDate()));
}

function formatMilestoneDateLabel(dateObj) {
  if (!(dateObj instanceof Date) || Number.isNaN(dateObj.getTime())) return 'Unknown date';
  return dateObj.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC'
  });
}

function formatMilestoneRelativeLabel(dateObj, todayDateObj) {
  if (!(dateObj instanceof Date) || Number.isNaN(dateObj.getTime())) return '';
  if (!(todayDateObj instanceof Date) || Number.isNaN(todayDateObj.getTime())) return '';
  const oneDayMs = 24 * 60 * 60 * 1000;
  const diffDays = Math.round((dateObj.getTime() - todayDateObj.getTime()) / oneDayMs);
  if (diffDays === 0) return 'Today';
  if (diffDays > 0) return `In ${diffDays} day${diffDays === 1 ? '' : 's'}`;
  const elapsedDays = Math.abs(diffDays);
  return `${elapsedDays} day${elapsedDays === 1 ? '' : 's'} ago`;
}

function normalizeMilestoneStatusForDisplay(status) {
  const text = String(status || '').trim();
  if (!text) return 'On Target';
  const hit = MILESTONE_STATUS_ORDER.find((entry) => entry.toLowerCase() === text.toLowerCase());
  return hit || 'On Target';
}

function milestoneStatusClass(status) {
  if (status === 'Completed') return 'milestone-status-pill--completed';
  if (status === 'Delayed') return 'milestone-status-pill--delayed';
  return 'milestone-status-pill--on-target';
}

function monthStartUtc(dateObj) {
  return new Date(Date.UTC(dateObj.getUTCFullYear(), dateObj.getUTCMonth(), 1));
}

function addMonthsUtc(dateObj, amount) {
  return new Date(Date.UTC(dateObj.getUTCFullYear(), dateObj.getUTCMonth() + amount, 1));
}

function monthKeyUtc(dateObj) {
  return `${dateObj.getUTCFullYear()}-${String(dateObj.getUTCMonth() + 1).padStart(2, '0')}`;
}

function formatMonthLabelUtc(dateObj) {
  return dateObj.toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function extractMilestoneWorkloadTagsHtml(workloadValue) {
  const refs = parseWorkloadRefs(workloadValue);
  if (!refs.length) return '';
  return `<div class="milestone-workload-tags">${refs
    .map((ref) => {
      const style = workloadTagStyle(ref.key);
      return `<span class="task-tag" style="background:${escapeHtml(style.background)};border-color:${escapeHtml(style.border)};color:${escapeHtml(style.text)}">${escapeHtml(ref.label)}</span>`;
    })
    .join('')}</div>`;
}

function computeMilestoneYearPointPct(dateObj, yearStartMs, yearSpanMs) {
  if (!(dateObj instanceof Date) || Number.isNaN(dateObj.getTime())) return 0;
  if (!Number.isFinite(yearSpanMs) || yearSpanMs <= 0) return 0;
  const ratio = (dateObj.getTime() - yearStartMs) / yearSpanMs;
  return Math.max(0, Math.min(100, ratio * 100));
}

/** Sum of parsed ARR across workloads (missing or unparsable values contribute 0). */
function sumWorkloadArrForRows(rows) {
  let total = 0;
  for (const row of rows) {
    const n = parseNumericValue(extractWorkloadArr(row));
    if (n != null) total += n;
  }
  return total;
}

function extractWorkloadArr(row) {
  const structured = getFirstDefinedValue(row, [
    'arr',
    'ARR',
    'annualRecurringRevenue',
    'AnnualRecurringRevenue',
    'annual_revenue',
    'AnnualRevenue'
  ]);
  if (structured != null && String(structured).trim()) return structured;
  const legacy = extractLegacyWorkloadFields(row);
  return legacy.arr;
}

function extractWorkloadStage(row) {
  const structured = getFirstDefinedValue(row, ['stage', 'Stage', 'opportunityStage', 'OpportunityStage']);
  if (typeof structured === 'string' && structured.trim()) return structured.trim();
  const legacy = extractLegacyWorkloadFields(row);
  return legacy.stage;
}

/** Display order for workload stage sections within an account column. */
const WORKLOAD_STAGE_SECTION_ORDER = Object.freeze(['Research', 'Discovery', 'Scope', 'Closed']);

function canonicalWorkloadStageGroupKey(row) {
  const raw = extractWorkloadStage(row);
  const text = String(raw || '').trim();
  if (!text) return 'Unspecified';
  for (const stage of WORKLOAD_STAGE_SECTION_ORDER) {
    if (stage.toLowerCase() === text.toLowerCase()) return stage;
  }
  return text;
}

function compareWorkloadStageGroupKeys(a, b) {
  const rank = (key) => {
    const i = WORKLOAD_STAGE_SECTION_ORDER.indexOf(key);
    if (i >= 0) return i;
    if (key === 'Unspecified') return 2000;
    return 1000;
  };
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  return a.localeCompare(b, undefined, { sensitivity: 'base' });
}

/** Map workload id string -> open tasks (same ids as `/api/tasks/open` workloadId). */
function groupOpenTasksByWorkloadId(openTasks) {
  const map = new Map();
  for (const task of Array.isArray(openTasks) ? openTasks : []) {
    const wid = String(task?.workloadId || '').trim();
    if (!wid) continue;
    if (!map.has(wid)) map.set(wid, []);
    map.get(wid).push(task);
  }
  return map;
}

function buildWorkloadOpenTaskBarHtml(workloadId, tasksByWorkloadId) {
  const key = String(workloadId || '').trim();
  const tasks = key ? tasksByWorkloadId.get(key) : null;
  if (!tasks || !tasks.length) return { cardClassSuffix: '', barHtml: '' };
  const sorted = tasks.slice().sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  const primary = sorted[0];
  const titleText = String(primary.task || 'Open task').trim() || 'Open task';
  const shown = summarize(titleText, 72);
  const more = sorted.length > 1 ? ` · +${sorted.length - 1} more` : '';
  const taskLines = sorted.map((t) => String(t.task || '').trim() || 'Open task');
  const fullTitles = taskLines.filter(Boolean).join(' · ');
  const ariaFull = taskLines.join('. ');
  const previewLinesHtml = taskLines
    .map((line) => `<div class="workload-open-task-preview-line">${escapeHtml(line)}</div>`)
    .join('');
  const ariaLabel = escapeHtml(ariaFull || titleText);
  return {
    cardClassSuffix: ' workload-card--open-tasks',
    barHtml: `<div class="workload-open-task-bar" role="group" aria-label="${ariaLabel}"><div class="workload-open-task-bar-preview" aria-hidden="true">${previewLinesHtml}</div><span class="workload-open-task-bar-label">Open task</span><span class="workload-open-task-bar-title">${escapeHtml(shown)}${escapeHtml(more)}</span></div>`
  };
}

function workloadStageTagStyle(stageValue) {
  const normalized = String(stageValue || '').trim().toLowerCase();
  if (!normalized) {
    return { background: '#eef5ef', border: '#cfe3d7', text: '#234336' };
  }
  if (normalized === 'research') {
    return { background: '#ffe6e6', border: '#f5a3a3', text: '#8f1d1d' };
  }
  if (normalized === 'discovery') {
    return { background: '#fff1dd', border: '#f3c78b', text: '#8b4f12' };
  }
  if (normalized === 'scope') {
    return { background: '#fff8d7', border: '#e9d989', text: '#775d00' };
  }
  if (normalized === 'technical validation' || normalized === 'technical valitation') {
    return { background: '#e8f7e9', border: '#9fd9a6', text: '#1f6d2a' };
  }
  if (normalized === 'closed') {
    return { background: '#ffe6e6', border: '#f5a3a3', text: '#8f1d1d' };
  }
  return { background: '#eef5ef', border: '#cfe3d7', text: '#234336' };
}

function extractSalesforceUrlFromText(value) {
  const text = String(value || '');
  if (!text.trim()) return '';
  const explicitMatch = text.match(/(?:^|\n)\s*(?:Salesforce(?:\s+Link)?|SFDC(?:\s+Link)?)\s*:\s*(https?:\/\/\S+)/i);
  if (explicitMatch) {
    const explicitHref = normalizeWebHref(explicitMatch[1]);
    if (explicitHref) return explicitHref;
  }
  const urlMatches = text.match(/https?:\/\/\S+/gi) || [];
  for (const raw of urlMatches) {
    const cleaned = raw.replace(/[),.;]+$/, '');
    const href = normalizeWebHref(cleaned);
    if (!href) continue;
    if (/salesforce\.com|force\.com/i.test(href)) return href;
  }
  return '';
}

function extractLegacyWorkloadFields(row) {
  const sourceTexts = [
    row?.description,
    row?.notes
  ].map((value) => String(value || ''));
  const combined = sourceTexts.join('\n');
  const stageMatch = combined.match(/(?:^|\n)\s*Stage\s*:\s*([^\n\r]+)/i);
  const arrMatch = combined.match(/(?:^|\n)\s*ARR\s*:\s*([^\n\r]+)/i);
  return {
    stage: stageMatch ? String(stageMatch[1] || '').trim() : '',
    arr: arrMatch ? String(arrMatch[1] || '').trim() : '',
    salesforceLink: extractSalesforceUrlFromText(combined)
  };
}

function cleanWorkloadDescriptionText(value) {
  return String(value || '')
    .split(/\r?\n/)
    .filter((line) => !/^\s*(Stage|ARR|Salesforce(?:\s+Link)?|SFDC(?:\s+Link)?)\s*:/i.test(String(line || '')))
    .join('\n')
    .trim();
}

function extractWorkloadContactNames(row) {
  const source = row && typeof row === 'object' ? row : {};
  const names = [];
  const seen = new Set();

  const pushName = (value) => {
    const text = String(value || '').trim();
    if (!text) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    names.push(text);
  };

  const contacts = Array.isArray(source.contacts) ? source.contacts : [];
  for (const contact of contacts) {
    if (contact == null) continue;
    if (typeof contact === 'string') {
      pushName(contact);
      continue;
    }
    if (typeof contact !== 'object' || Array.isArray(contact)) continue;
    pushName(contact.name || contact.contactName || contact.fullName);
  }

  return names;
}

function extractSalesforceLink(row) {
  const preferredKeys = [
    'salesforceLink',
    'salesforceUrl',
    'salesforceURL',
    'SalesforceLink',
    'SalesforceURL',
    'sfLink',
    'sfUrl',
    'sfdcUrl',
    'sfdcLink'
  ];
  const preferred = getFirstDefinedValue(row, preferredKeys);
  if (typeof preferred === 'string') {
    const href = normalizeWebHref(preferred);
    if (href) return href;
  }
  for (const [key, value] of Object.entries(row || {})) {
    if (typeof value !== 'string') continue;
    if (!/(salesforce|sfdc|sf)/i.test(String(key || ''))) continue;
    const href = normalizeWebHref(value);
    if (href) return href;
  }
  const legacy = extractLegacyWorkloadFields(row);
  return legacy.salesforceLink || '';
}

function buildWorkloadSalesforceLinkHtml(href) {
  const safeHref = escapeHtml(href);
  return `<a class="workload-salesforce-link" href="${safeHref}" target="_blank" rel="noopener noreferrer" aria-label="Open workload in Salesforce">
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M16.7 8.8a3.8 3.8 0 0 0-3.2 1.8 3 3 0 0 0-5.2 1.9v.2A2.8 2.8 0 0 0 8.5 18h8.4a3.1 3.1 0 0 0-.2-6.2z" fill="currentColor"/>
    </svg>
  </a>`;
}

function parseDocumentLinks(value) {
  const source = Array.isArray(value) ? value : [value];
  const out = [];
  const seen = new Set();
  for (const item of source) {
    if (!item) continue;
    let name = '';
    let url = '';
    if (typeof item === 'string') {
      const text = item.trim();
      const markdownMatch = text.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/i);
      if (markdownMatch) {
        name = String(markdownMatch[1] || '').trim();
        url = String(markdownMatch[2] || '').trim();
      } else {
        const urlMatch = text.match(/https?:\/\/\S+/i);
        if (!urlMatch) continue;
        url = String(urlMatch[0] || '').replace(/[),.;]+$/, '').trim();
        const before = text.slice(0, urlMatch.index).trim().replace(/[:\-–\s]+$/, '').trim();
        const after = text.slice((urlMatch.index || 0) + urlMatch[0].length).trim();
        name = (before || after || '').trim();
      }
    } else if (typeof item === 'object' && !Array.isArray(item)) {
      name = String(item.name || item.title || item.label || '').trim();
      url = String(item.url || item.link || item.href || '').trim();
    }
    const href = normalizeWebHref(url);
    if (!name || !href) continue;
    const key = href.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, href });
  }
  return out;
}

function extractRecordDocumentLinks(row) {
  const links = [];
  const keys = [
    'documentLinks',
    'DocumentLinks',
    'docs',
    'Docs',
    'link',
    'Link',
    'links',
    'Links',
    'attachment',
    'Attachment',
    'attachments',
    'Attachments',
    'attachmentLinks',
    'AttachmentLinks',
    'attachedLinks',
    'AttachedLinks'
  ];
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(row || {}, key)) continue;
    links.push(...parseDocumentLinks(row[key]));
  }
  const deduped = [];
  const seen = new Set();
  for (const link of links) {
    const key = String(link.href || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(link);
  }
  return deduped;
}

function renderRecordDocumentLinksHtml(row, className = 'record-doc-links') {
  const links = extractRecordDocumentLinks(row);
  if (!links.length) return '';
  return `<div class="${escapeHtml(className)}">${links.map((link) => `<a class="record-doc-link" href="${escapeHtml(link.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.name)}</a>`).join('')}</div>`;
}

function buildWorkloadMoreInfoHtml(row) {
  const source = row && typeof row === 'object' ? row : {};
  const excludedKeys = new Set([
    '_id',
    'id',
    'name',
    'Name',
    'accountId',
    'AccountId',
    'accountName',
    'AccountName',
    'contacts',
    'contactIds',
    'Contacts',
    'ContactIds',
    'description',
    'Description',
    'notes',
    'Notes',
    'updatedAt',
    'createdAt',
    'arr',
    'ARR',
    'stage',
    'Stage',
    'opportunityStage',
    'OpportunityStage',
    'annualRecurringRevenue',
    'AnnualRecurringRevenue',
    'annual_revenue',
    'AnnualRevenue',
    'salesforceLink',
    'salesforceUrl',
    'salesforceURL',
    'SalesforceLink',
    'SalesforceURL',
    'sfLink',
    'sfUrl',
    'sfdcUrl',
    'sfdcLink',
    'documentLinks',
    'DocumentLinks',
    'docs',
    'Docs'
  ]);
  const entries = Object.entries(source).filter(([key, value]) => {
    if (excludedKeys.has(key)) return false;
    if (isEmptyContactValue(value)) return false;
    return true;
  });
  if (!entries.length) return '<div class="workload-extra-empty">No additional workload details.</div>';
  return entries.map(([key, value]) => {
    return `<div class="workload-extra-row"><div class="workload-extra-key">${escapeHtml(formatContactFieldLabel(key))}:</div><div class="workload-extra-value">${escapeHtml(formatContactFieldValue(value))}</div></div>`;
  }).join('');
}

function hashString(value) {
  const text = String(value || '');
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function workloadTagStyle(workloadKey) {
  const hash = hashString(workloadKey);
  const hue = hash % 360;
  return {
    background: `hsl(${hue} 80% 92%)`,
    border: `hsl(${hue} 45% 62%)`,
    text: `hsl(${hue} 55% 22%)`
  };
}

function formatContactFieldLabel(key) {
  if (CONTACT_CANONICAL_LABELS[key]) return CONTACT_CANONICAL_LABELS[key];
  return String(key || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function shouldHideContactExtraField(key) {
  const normalized = String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalized === 'accountid'
    || normalized === 'accountids'
    || normalized === 'workloadid'
    || normalized === 'workloadids';
}

function formatContactFieldValue(value) {
  if (value == null) return 'N/A';
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return value.map((item) => {
      if (item == null) return 'null';
      if (typeof item === 'object') return JSON.stringify(item);
      return String(item);
    }).join(', ');
  }
  if (typeof value === 'object') return JSON.stringify(value);
  const text = String(value).trim();
  return text || 'N/A';
}

function getFirstDefinedContactValue(row, keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(row || {}, key)) return row[key];
  }
  return undefined;
}

function normalizeWebHref(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  let candidate = text;
  if (!/^https?:\/\//i.test(candidate) && /^[\w.-]+\.[A-Za-z]{2,}(\/|$)/.test(candidate)) {
    candidate = `https://${candidate}`;
  }
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.toString();
  } catch (_err) {
    return '';
  }
}

function isEmptyContactValue(value) {
  if (value == null) return true;
  if (typeof value === 'string') return !String(value).trim();
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

function formatContactFieldValueHtml(key, value) {
  if (key === 'notes') {
    const notesHtml = formatContactNotesValueHtml(value);
    if (notesHtml) return notesHtml;
  }
  if (key === 'linkedIn' && typeof value === 'string') {
    const href = normalizeWebHref(value);
    if (href) return buildLinkedInLinkHtml(href);
  }
  if (key === 'workloadIds') {
    const workloadHtml = formatWorkloadRefsHtml(value);
    if (workloadHtml) return workloadHtml;
  }
  if (key === 'reportsTo') {
    const reportsToName = formatReportsToName(value);
    if (reportsToName) return escapeHtml(reportsToName);
  }
  if ((key === 'linkedIn' || key === 'website' || key === 'imageUrl') && typeof value === 'string') {
    const href = normalizeWebHref(value);
    if (href) {
      return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(key === 'imageUrl' ? 'Open image' : href)}</a>`;
    }
  }
  return escapeHtml(formatContactFieldValue(value));
}

function buildLinkedInLinkHtml(href) {
  const safeHref = escapeHtml(href);
  return `<a class="linkedin-link" href="${safeHref}" target="_blank" rel="noopener noreferrer" aria-label="Open LinkedIn profile">
    <span class="linkedin-logo" aria-hidden="true">in</span>
    <span class="linkedin-link-text">Open LinkedIn</span>
  </a>`;
}

function buildLinkedInLogoOnlyHtml(href) {
  const safeHref = escapeHtml(href);
  return `<a class="contact-card-linkedin" href="${safeHref}" target="_blank" rel="noopener noreferrer" aria-label="Open LinkedIn profile">
    <span class="linkedin-logo" aria-hidden="true">in</span>
  </a>`;
}

function renderContactLinkedInHeaderAction(row) {
  const linkedInValue = getFirstDefinedContactValue(row, ['linkedIn', ...(CONTACT_FIELD_ALIASES.linkedIn || [])]);
  if (typeof linkedInValue !== 'string') return '';
  const href = normalizeWebHref(linkedInValue);
  if (!href) return '';
  return buildLinkedInLogoOnlyHtml(href);
}

function renderInitiativeContactMiniCard(c) {
  const name = String(c?.name || c?.contactId || '').trim() || 'Contact';
  const titleRaw = c?.title != null ? String(c.title).trim() : '';
  const liVal = getFirstDefinedContactValue(c, ['linkedIn', ...(CONTACT_FIELD_ALIASES.linkedIn || [])]);
  const href = typeof liVal === 'string' ? normalizeWebHref(liVal) : '';
  const safeHref = href ? escapeHtml(href) : '';
  const liBlock = href
    ? `<a class="initiative-linkedin-btn" href="${safeHref}" target="_blank" rel="noopener noreferrer" aria-label="Open LinkedIn profile"><span class="linkedin-logo" aria-hidden="true">in</span></a>`
    : '';
  const titleBlock = titleRaw
    ? `<div class="initiative-contact-mini-title">${escapeHtml(titleRaw)}</div>`
    : '';
  const rootClass = href ? 'initiative-contact-mini initiative-contact-mini--linkedin' : 'initiative-contact-mini';
  return `<div class="${rootClass}">
    <div class="initiative-contact-mini-name">${escapeHtml(name)}</div>
    ${titleBlock}
    ${liBlock}
  </div>`;
}

function normalizeNotesValueForDisplay(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'object') return [value];
  if (typeof value !== 'string') return [];
  const text = value.trim();
  if (!text) return [];
  if (!((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']')))) {
    return [{ text }];
  }
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') return [parsed];
  } catch (_err) {
    return [{ text }];
  }
  return [{ text }];
}

function formatNoteTimestamp(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString();
}

function formatContactNotesValueHtml(value) {
  const notes = normalizeNotesValueForDisplay(value)
    .map((entry) => {
      if (entry == null) return null;
      if (typeof entry === 'string') {
        const text = String(entry);
        return text.trim() ? { text, author: 'Unknown', updatedAt: '' } : null;
      }
      if (typeof entry !== 'object') return null;
      const text = String(entry.text || '');
      if (!text.trim()) return null;
      return {
        text,
        author: String(entry.author || 'Unknown').trim() || 'Unknown',
        updatedAt: formatNoteTimestamp(entry.updatedAt || entry.createdAt)
      };
    })
    .filter(Boolean);
  if (!notes.length) return '';
  return notes.map((note) => {
    const metaBits = [note.author, note.updatedAt].filter(Boolean);
    const meta = metaBits.length ? `<div class="contact-note-meta">${escapeHtml(metaBits.join(' - '))}</div>` : '';
    return `<div class="contact-note-entry"><div class="contact-note-text">${escapeHtml(note.text)}</div>${meta}</div>`;
  }).join('');
}

function formatReportsToName(value) {
  if (value == null) return '';
  if (typeof value === 'object' && !Array.isArray(value)) {
    return String(value.name || '').trim();
  }
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text) return '';
  if (!(text.startsWith('{') && text.endsWith('}'))) return text;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return String(parsed.name || '').trim() || text;
    }
  } catch (_err) {
    return text;
  }
  return text;
}

function formatWorkloadRefsHtml(value) {
  const items = Array.isArray(value) ? value : [value];
  const labels = [];
  for (const item of items) {
    if (item == null) continue;
    if (typeof item === 'string') {
      const id = item.trim();
      if (id) labels.push(id);
      continue;
    }
    if (typeof item !== 'object' || Array.isArray(item)) continue;
    const workloadId = String(item.workloadId || item.id || '').trim();
    if (!workloadId) continue;
    const name = String(item.name || item.workloadName || '').trim();
    labels.push(name ? `${name} (${workloadId})` : workloadId);
  }
  if (!labels.length) return '';
  return escapeHtml(labels.join(', '));
}

function parseWorkloadRefs(value) {
  const refs = [];
  const pushRef = (id, name) => {
    const normalizedId = String(id || '').trim();
    const normalizedName = String(name || '').trim();
    const key = normalizedId || normalizedName;
    const label = normalizedName || normalizedId;
    if (!key || !label) return;
    refs.push({ key, label });
  };

  const parseItem = (item) => {
    if (item == null) return;
    if (Array.isArray(item)) {
      item.forEach(parseItem);
      return;
    }

    if (typeof item === 'string') {
      const text = item.trim();
      if (!text) return;
      if ((text.startsWith('[') && text.endsWith(']')) || (text.startsWith('{') && text.endsWith('}'))) {
        try {
          parseItem(JSON.parse(text));
          return;
        } catch (_err) {
          // Ignore parse failures and keep plain-string handling.
        }
      }
      const namedIdMatch = text.match(/^(.*)\(([^()]+)\)\s*$/);
      if (namedIdMatch) {
        pushRef(namedIdMatch[2], namedIdMatch[1].trim());
        return;
      }
      pushRef(text, '');
      return;
    }

    if (typeof item !== 'object') return;
    const workloadId = String(item.workloadId || item.id || item._id || '').trim();
    const workloadName = String(item.name || item.workloadName || item.label || '').trim();
    pushRef(workloadId, workloadName);
  };

  parseItem(value);

  const deduped = [];
  const seen = new Set();
  for (const ref of refs) {
    const dedupeKey = String(ref.key).toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    deduped.push(ref);
  }
  return deduped;
}

function extractContactWorkloadRefs(row) {
  const source = row && typeof row === 'object' ? row : {};
  const workloadKeys = ['workloadIds', 'WorkloadIds', 'workloadId', 'WorkloadId', 'workloads', 'Workloads'];
  const merged = [];
  for (const key of workloadKeys) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    merged.push(...parseWorkloadRefs(source[key]));
  }
  const deduped = [];
  const seen = new Set();
  for (const ref of merged) {
    const dedupeKey = String(ref.key).toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    deduped.push(ref);
  }
  return deduped;
}

function renderContactWorkloadTagsHtml(row) {
  const refs = extractContactWorkloadRefs(row);
  if (!refs.length) return '';
  const tagsHtml = refs.map((ref) => {
    const style = workloadTagStyle(ref.key);
    return `<span class="task-tag" style="background:${escapeHtml(style.background)};border-color:${escapeHtml(style.border)};color:${escapeHtml(style.text)}">${escapeHtml(ref.label)}</span>`;
  }).join('');
  return `<div class="contact-workload-tags">${tagsHtml}</div>`;
}

function buildContactMoreInfoHtml(row) {
  const source = row && typeof row === 'object' ? row : {};
  const excludedKeys = new Set([
    '_id',
    'id',
    'contactId',
    'name',
    'Name',
    'title',
    'Title',
    'email',
    'Email',
    'updatedAt',
    'accountId',
    'AccountId',
    'accountIds',
    'AccountIds',
    'workloadId',
    'WorkloadId',
    'workloadIds',
    'WorkloadIds',
    'documentLinks',
    'DocumentLinks',
    'docs',
    'Docs'
  ]);
  const entries = [];

  for (const canonicalKey of CONTACT_EXTRA_FIELD_ORDER) {
    if (shouldHideContactExtraField(canonicalKey)) continue;
    const aliases = CONTACT_FIELD_ALIASES[canonicalKey] || [];
    const value = getFirstDefinedContactValue(source, [canonicalKey, ...aliases]);
    if (isEmptyContactValue(value)) continue;
    entries.push([canonicalKey, value]);
    excludedKeys.add(canonicalKey);
    aliases.forEach((alias) => excludedKeys.add(alias));
  }

  for (const [key, value] of Object.entries(source)) {
    if (excludedKeys.has(key) || shouldHideContactExtraField(key) || isEmptyContactValue(value)) continue;
    entries.push([key, value]);
  }

  if (!entries.length) {
    return '<div class="contact-extra-empty">No additional contact details.</div>';
  }
  return entries.map(([key, value]) => {
    return `<div class="contact-extra-row"><div class="contact-extra-key">${escapeHtml(formatContactFieldLabel(key))}:</div><div class="contact-extra-value">${formatContactFieldValueHtml(key, value)}</div></div>`;
  }).join('');
}

async function apiGet(pathname, options = {}) {
  const url = state.apiBaseUrl ? `${state.apiBaseUrl}${pathname}` : pathname;
  const headers = options.skipAuth
    ? { 'Content-Type': 'application/json' }
    : authHeaders({ 'Content-Type': 'application/json' });
  const res = await fetch(url, { method: 'GET', headers });
  const raw = await res.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch (_err) {
    throw new Error('Server returned non-JSON response.');
  }
  throwIfApiError(res, data);
  return data;
}

async function apiPost(pathname, body, options = {}) {
  const url = state.apiBaseUrl ? `${state.apiBaseUrl}${pathname}` : pathname;
  const headers = options.skipAuth
    ? { 'Content-Type': 'application/json' }
    : authHeaders({ 'Content-Type': 'application/json' });
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body || {}) });
  const raw = await res.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch (_err) {
    throw new Error('Server returned non-JSON response.');
  }
  throwIfApiError(res, data);
  return data;
}

async function apiDelete(pathname, options = {}) {
  const url = state.apiBaseUrl ? `${state.apiBaseUrl}${pathname}` : pathname;
  const headers = options.skipAuth
    ? { 'Content-Type': 'application/json' }
    : authHeaders({ 'Content-Type': 'application/json' });
  const res = await fetch(url, { method: 'DELETE', headers });
  const raw = await res.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch (_err) {
    throw new Error('Server returned non-JSON response.');
  }
  throwIfApiError(res, data);
  return data;
}

function pickRecorderMimeType() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  for (const t of types) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

function isVoicePushToTalkShortcut(event) {
  return (
    event.metaKey &&
    event.shiftKey &&
    !event.ctrlKey &&
    !event.altKey &&
    (event.key === '1' || event.code === 'Digit1')
  );
}

/** True when ⌘, Shift, or the digit key is released — any of these ends the chord. Relying only on Digit1 keyup fails when users release Meta/Shift first or when keyup for "1" is lost after preventDefault on keydown. */
function isVoiceChordReleaseKey(event) {
  if (event.code === 'Digit1' || event.key === '1') return true;
  if (event.code === 'MetaLeft' || event.code === 'MetaRight') return true;
  if (event.key === 'Meta') return true;
  if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') return true;
  if (event.key === 'Shift') return true;
  return false;
}

function stopVoiceMediaStream() {
  if (!voiceMediaStream) return;
  voiceMediaStream.getTracks().forEach((t) => t.stop());
  voiceMediaStream = null;
}

async function transcribeVoiceBlob(blob) {
  ensureSignedIn();
  const fd = new FormData();
  fd.append('file', blob, 'recording.webm');
  const url = state.apiBaseUrl ? `${state.apiBaseUrl}/api/voice/transcribe` : '/api/voice/transcribe';
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(),
    body: fd
  });
  const raw = await res.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch (_err) {
    throw new Error('Server returned non-JSON response.');
  }
  throwIfApiError(res, data);
  return String(data.text || '').trim();
}

async function playAssistantTts(text, options = {}) {
  ensureSignedIn();
  const responseMode =
    typeof options.responseMode === 'string' && options.responseMode.trim()
      ? options.responseMode.trim()
      : RESPONSE_MODE_VOICE_CONVERSATIONAL;
  const rewriteForSpeech = options.rewriteForSpeech !== false;
  const url = state.apiBaseUrl ? `${state.apiBaseUrl}/api/voice/speak` : '/api/voice/speak';
  const headers = authHeaders({ 'Content-Type': 'application/json' });
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text, responseMode, rewriteForSpeech })
  });
  if (!res.ok) {
    const raw = await res.text();
    let msg = raw;
    try {
      const j = JSON.parse(raw);
      if (j && j.error) msg = j.error;
    } catch (_e) {}
    throw new Error(msg || `HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const objUrl = URL.createObjectURL(blob);
  const audio = new Audio(objUrl);
  try {
    await audio.play();
    await new Promise((resolve, reject) => {
      audio.onended = resolve;
      audio.onerror = () => reject(new Error('Audio playback failed'));
    });
  } finally {
    URL.revokeObjectURL(objUrl);
  }
}

async function startVoiceCapture() {
  if (voicePttRecording) return;
  try {
    ensureSignedIn();
  } catch (err) {
    setStatus(err.message || 'Sign in with Google to continue.');
    return;
  }
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    setStatus('Voice input is not supported in this browser.');
    return;
  }
  voiceCancelStart = false;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    setStatus(`Microphone: ${err.message || 'permission denied'}`);
    return;
  }
  if (voiceCancelStart) {
    stream.getTracks().forEach((t) => t.stop());
    return;
  }
  voiceMediaStream = stream;
  voiceChunks = [];
  const mime = pickRecorderMimeType();
  try {
    voiceMediaRecorder = new MediaRecorder(voiceMediaStream, mime ? { mimeType: mime } : undefined);
  } catch (_err) {
    stopVoiceMediaStream();
    voiceMediaRecorder = null;
    setStatus('Could not start voice recorder.');
    return;
  }
  if (voiceCancelStart) {
    stopVoiceMediaStream();
    voiceMediaRecorder = null;
    return;
  }
  voiceMediaRecorder.ondataavailable = (ev) => {
    if (ev.data && ev.data.size > 0) voiceChunks.push(ev.data);
  };
  voiceMediaRecorder.onerror = () => setStatus('Recording error');
  voiceMediaRecorder.start(200);
  voicePttRecording = true;
  updateVoiceRecordingUi(true);
  setStatus('Listening…');
}

function stopVoiceCaptureAndSend() {
  if (!voicePttRecording) return;
  const rec = voiceMediaRecorder;
  if (!rec) {
    voicePttRecording = false;
    updateVoiceRecordingUi(false);
    stopVoiceMediaStream();
    return;
  }
  voicePttRecording = false;
  updateVoiceRecordingUi(false);
  voiceMediaRecorder = null;
  rec.onstop = async () => {
    stopVoiceMediaStream();
    const blob = new Blob(voiceChunks, { type: rec.mimeType || 'audio/webm' });
    voiceChunks = [];
    if (blob.size < 200) {
      setStatus('');
      return;
    }
    setStatus('Transcribing…');
    try {
      const text = await transcribeVoiceBlob(blob);
      if (!String(text).trim()) {
        setStatus('No speech detected');
        return;
      }
      state.voiceTurnExpectTts = true;
      await sendChatMessage(text);
    } catch (err) {
      setStatus(err.message || String(err));
    }
  };
  if (rec.state === 'recording') {
    rec.stop();
  } else {
    stopVoiceMediaStream();
    voiceChunks = [];
    setStatus('');
  }
}

function onVoiceKeyDown(event) {
  if (!isVoicePushToTalkShortcut(event)) return;
  if (event.repeat) return;
  event.preventDefault();
  voiceShortcutHeld = true;
  startVoiceCapture();
}

function onVoiceKeyUp(event) {
  if (!isVoiceChordReleaseKey(event)) return;
  const inVoiceSession = voiceShortcutHeld || voicePttRecording;
  if (!inVoiceSession) return;
  voiceShortcutHeld = false;
  event.preventDefault();
  if (!voicePttRecording) {
    voiceCancelStart = true;
    return;
  }
  stopVoiceCaptureAndSend();
}

function onChatMicPointerDown(event) {
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  event.preventDefault();
  chatMicBtnEl?.setPointerCapture?.(event.pointerId);
  voiceMicPointerHeld = true;
  startVoiceCapture();
}

function onChatMicPointerUp(event) {
  if (!voiceMicPointerHeld) return;
  voiceMicPointerHeld = false;
  if (chatMicBtnEl?.hasPointerCapture?.(event.pointerId)) {
    chatMicBtnEl.releasePointerCapture(event.pointerId);
  }
  if (!voicePttRecording) {
    voiceCancelStart = true;
    return;
  }
  stopVoiceCaptureAndSend();
}

function onChatMicPointerLeave(event) {
  if (!voiceMicPointerHeld) return;
  voiceMicPointerHeld = false;
  if (chatMicBtnEl?.hasPointerCapture?.(event.pointerId)) {
    chatMicBtnEl.releasePointerCapture(event.pointerId);
  }
  if (!voicePttRecording) {
    voiceCancelStart = true;
    return;
  }
  stopVoiceCaptureAndSend();
}

function setupChatMicBtn() {
  if (!chatMicBtnEl) return;
  if (!isVoiceInputSupported()) {
    chatMicBtnEl.hidden = true;
    chatMicBtnEl.title = 'Voice input not supported in this browser';
    return;
  }
  chatMicBtnEl.hidden = false;
  chatMicBtnEl.addEventListener('pointerdown', onChatMicPointerDown);
  chatMicBtnEl.addEventListener('pointerup', onChatMicPointerUp);
  chatMicBtnEl.addEventListener('pointercancel', onChatMicPointerUp);
  chatMicBtnEl.addEventListener('pointerleave', onChatMicPointerLeave);
}

function cardHtml(title, body, meta = '') {
  return `<article class="card"><h4>${escapeHtml(title)}</h4><div>${body}</div><div class="meta">${escapeHtml(meta)}</div></article>`;
}

function renderHomeMetricLines(items, renderLine, emptyText) {
  if (!Array.isArray(items) || !items.length) {
    return `<div class="meta home-metric-empty">${escapeHtml(emptyText)}</div>`;
  }
  return `<ul class="home-metric-list">${items.map((item) => `<li>${renderLine(item)}</li>`).join('')}</ul>`;
}

function homeColumnCardHtml(title, subtitle, listHtml) {
  return `<article class="card home-column-card">
    <h4>${escapeHtml(title)}</h4>
    <div class="meta home-column-subtitle">${escapeHtml(subtitle)}</div>
    ${listHtml}
  </article>`;
}

function setCardsFromHtml(html) {
  cardsContainerEl.innerHTML = html || '';
}

function priorityRank(priority) {
  const value = String(priority || '').trim();
  if (value === 'Priority 1') return 1;
  if (value === 'Priority 2') return 2;
  if (value === 'Priority 3') return 3;
  if (value === 'Priority 4') return 4;
  return 99;
}

function priorityLabel(priority) {
  const value = String(priority || '').trim();
  return value || 'No Priority';
}

function sortNodesByLabel(a, b) {
  return String(a.label || '').localeCompare(String(b.label || ''), undefined, { sensitivity: 'base' });
}

function createNodeId(prefix, fallback, index) {
  const value = String(fallback || '').trim();
  if (value) return `${prefix}_${value}`;
  return `${prefix}_${index + 1}`;
}

function buildAccountForest(items) {
  const nodes = items.map((row, index) => ({
    id: createNodeId('account', row._id || row.id, index),
    label: String(row.name || '').trim() || 'Untitled account',
    parentLabel: String(row.parentAccountName || '').trim(),
    item: row,
    parent: null,
    children: []
  }));

  const byName = new Map();
  for (const node of nodes) {
    const key = node.label.toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(node);
  }

  const roots = [];
  for (const node of nodes) {
    if (!node.parentLabel) {
      roots.push(node);
      continue;
    }
    const candidates = byName.get(node.parentLabel.toLowerCase()) || [];
    const parent = candidates.find((candidate) => candidate.id !== node.id) || null;
    if (!parent) {
      roots.push(node);
      continue;
    }
    node.parent = parent;
    parent.children.push(node);
  }

  for (const node of nodes) {
    node.children.sort(sortNodesByLabel);
  }
  roots.sort(sortNodesByLabel);
  return roots;
}

function buildContactsForest(items) {
  const byAccount = new Map();
  for (const row of items) {
    const accountName = String(row.accountName || '').trim() || 'Unassigned Account';
    if (!byAccount.has(accountName)) byAccount.set(accountName, []);
    byAccount.get(accountName).push(row);
  }

  const roots = [];
  let groupIndex = 0;
  for (const [accountName, contacts] of byAccount) {
    const contactNodes = contacts
      .map((row, index) => ({
        id: createNodeId('contact', row._id || row.id || `${accountName}_${index}`, index),
        label: String(row.name || '').trim() || 'Untitled contact',
        item: row,
        parent: null,
        children: []
      }))
      .sort(sortNodesByLabel);

    const byContactId = new Map();
    const byName = new Map();
    for (const node of contactNodes) {
      const row = node.item || {};
      const ids = [row._id, row.id, row.contactId]
        .map((id) => String(id || '').trim())
        .filter(Boolean);
      for (const rawId of ids) {
        byContactId.set(rawId, node);
      }
      const nameKey = String(node.label || '').toLowerCase();
      if (!byName.has(nameKey)) byName.set(nameKey, []);
      byName.get(nameKey).push(node);
    }

    for (const node of contactNodes) {
      const reportsTo = node.item && typeof node.item.reportsTo === 'object' ? node.item.reportsTo : null;
      if (!reportsTo) continue;
      const managerId = String(reportsTo.contactId || reportsTo.id || '').trim();
      const managerName = String(reportsTo.name || '').trim().toLowerCase();

      let managerNode = null;
      if (managerId && byContactId.has(managerId)) {
        managerNode = byContactId.get(managerId);
      } else if (managerName && byName.has(managerName)) {
        managerNode = (byName.get(managerName) || []).find((candidate) => candidate.id !== node.id) || null;
      }

      if (!managerNode || managerNode.id === node.id) continue;
      node.parent = managerNode;
      managerNode.children.push(node);
    }

    for (const node of contactNodes) {
      node.children.sort(sortNodesByLabel);
    }
    const rootContacts = contactNodes.filter((node) => !node.parent).sort(sortNodesByLabel);

    const root = {
      id: createNodeId('contact_group', accountName, groupIndex),
      label: accountName,
      item: null,
      parent: null,
      children: rootContacts
    };
    for (const child of root.children) child.parent = root;
    roots.push(root);
    groupIndex += 1;
  }

  roots.sort(sortNodesByLabel);
  return roots;
}

function buildContactRowsByAccount(items) {
  const byAccount = new Map();
  for (const row of items) {
    const accountName = String(row?.accountName || '').trim() || 'Unassigned Account';
    if (!byAccount.has(accountName)) byAccount.set(accountName, []);
    byAccount.get(accountName).push(row);
  }
  const sortedAccounts = Array.from(byAccount.keys()).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  return { byAccount, sortedAccounts };
}

function buildContactTableColumnOptions(items) {
  const excludedKeys = new Set([
    '_id',
    'id',
    'contactId',
    'Name',
    'Email',
    'Title',
    'updatedAt',
    'accountName',
    'accountId',
    'AccountId',
    'accountIds',
    'AccountIds',
    'documentLinks',
    'DocumentLinks',
    'docs',
    'Docs'
  ]);
  const seen = new Set(CONTACT_DEFAULT_TABLE_COLUMNS);
  const ordered = CONTACT_DEFAULT_TABLE_COLUMNS.map((key) => ({ key, label: formatContactFieldLabel(key) }));

  for (const canonicalKey of CONTACT_EXTRA_FIELD_ORDER) {
    if (seen.has(canonicalKey) || shouldHideContactExtraField(canonicalKey)) continue;
    seen.add(canonicalKey);
    ordered.push({ key: canonicalKey, label: formatContactFieldLabel(canonicalKey) });
    const aliases = CONTACT_FIELD_ALIASES[canonicalKey] || [];
    aliases.forEach((alias) => excludedKeys.add(alias));
  }

  const dynamic = new Set();
  for (const row of items) {
    for (const [key, value] of Object.entries(row || {})) {
      if (isEmptyContactValue(value)) continue;
      if (excludedKeys.has(key) || shouldHideContactExtraField(key)) continue;
      if (seen.has(key)) continue;
      dynamic.add(key);
    }
  }
  Array.from(dynamic).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    .forEach((key) => ordered.push({ key, label: formatContactFieldLabel(key) }));
  return ordered;
}

function getContactFieldValueForTable(row, key) {
  const source = row && typeof row === 'object' ? row : {};
  if (key === 'name') return getFirstDefinedContactValue(source, ['name', 'Name']);
  if (key === 'email') return getFirstDefinedContactValue(source, ['email', 'Email']);
  if (key === 'title') return getFirstDefinedContactValue(source, ['title', 'Title']);
  if (key === 'reportsTo') return formatReportsToName(getFirstDefinedContactValue(source, ['reportsTo', 'ReportsTo'])) || '';
  if (key === 'workloadIds') {
    const refs = extractContactWorkloadRefs(source).map((ref) => ref.label);
    return refs.join(', ');
  }
  const aliases = CONTACT_FIELD_ALIASES[key] || [];
  const value = getFirstDefinedContactValue(source, [key, ...aliases]);
  if (value !== undefined) return value;
  return source[key];
}

function renderContactAccountFiltersHtml(sortedAccounts, byAccount) {
  return sortedAccounts.map((accountName) => {
    const rows = byAccount.get(accountName) || [];
    const suffix = rows.length === 1 ? '' : 's';
    return `
      <label class="contact-account-filter-item">
        <input type="checkbox" class="contact-account-filter-cb" data-contact-filter-key="${escapeHtml(accountName)}" checked>
        <span>${escapeHtml(accountName)} (${rows.length} contact${suffix})</span>
      </label>
    `;
  }).join('');
}

function renderContactColumnsFiltersHtml(columnOptions) {
  return columnOptions.map((column) => {
    const checked = contactsViewState.selectedColumns.has(column.key);
    return `
      <label class="contact-table-column-item">
        <input type="checkbox" class="contact-table-column-cb" data-contact-column-key="${escapeHtml(column.key)}" ${checked ? 'checked' : ''}>
        <span>${escapeHtml(column.label)}</span>
      </label>
    `;
  }).join('');
}

function renderContactsHierarchyBoard(roots) {
  const treeHtml = roots.map((root) => `
    <section class="hierarchy-tree contact-hierarchy-tree contact-account-section" data-contact-filter-key="${escapeHtml(root.label)}">
      <svg class="hierarchy-lines" aria-hidden="true"></svg>
      <div class="hierarchy-levels contact-tree-layout">
        ${renderContactHierarchyBranch(root)}
      </div>
    </section>
  `).join('');
  return `<div class="hierarchy-board contacts-hierarchy-board">${treeHtml}</div>`;
}

function renderContactsTableBoard(sortedAccounts, byAccount, columnOptions) {
  const headerHtml = columnOptions.map((column) => {
    const hiddenClass = contactsViewState.selectedColumns.has(column.key) ? '' : ' contact-table-column--hidden';
    return `<th class="contact-table-column${hiddenClass}" data-contact-column-key="${escapeHtml(column.key)}">${escapeHtml(column.label)}</th>`;
  }).join('');
  const headerWithActionsHtml = `${headerHtml}<th class="contact-table-actions-col">Actions</th>`;

  const sectionsHtml = sortedAccounts.map((accountName) => {
    const rows = (byAccount.get(accountName) || []).slice().sort((a, b) => {
      const nameA = String(a?.name || '').trim();
      const nameB = String(b?.name || '').trim();
      return nameA.localeCompare(nameB, undefined, { sensitivity: 'base' });
    });
    const bodyHtml = rows.map((row) => {
      const contactId = String(row?._id || row?.id || row?.contactId || '').trim();
      const cellHtml = columnOptions.map((column) => {
        const hiddenClass = contactsViewState.selectedColumns.has(column.key) ? '' : ' contact-table-column--hidden';
        const value = getContactFieldValueForTable(row, column.key);
        return `<td class="contact-table-column${hiddenClass}" data-contact-column-key="${escapeHtml(column.key)}">${escapeHtml(formatContactFieldValue(value))}</td>`;
      }).join('');
      const actionHtml = contactId
        ? `<button type="button" class="contact-delete-btn contact-delete-btn--table" data-contact-id="${escapeHtml(contactId)}" data-contact-name="${escapeHtml(String(row?.name || 'Untitled contact'))}">Delete</button>`
        : '';
      return `<tr>${cellHtml}<td class="contact-table-actions-col">${actionHtml}</td></tr>`;
    }).join('');
    return `
      <section class="contact-account-table-section contact-account-section" data-contact-filter-key="${escapeHtml(accountName)}">
        <header class="contact-account-table-header">
          <h3>${escapeHtml(accountName)}</h3>
          <div class="meta">${rows.length} contact${rows.length === 1 ? '' : 's'}</div>
        </header>
        <div class="contact-account-table-wrap">
          <table class="contacts-table">
            <thead><tr>${headerWithActionsHtml}</tr></thead>
            <tbody>${bodyHtml}</tbody>
          </table>
        </div>
      </section>
    `;
  }).join('');
  return `<div class="contacts-table-board">${sectionsHtml}</div>`;
}

function applyContactsViewState(viewRoot) {
  if (!viewRoot) return;
  const showTable = contactsViewState.mode === 'table';
  viewRoot.classList.toggle('contacts-view--table-mode', showTable);
  const hierarchyBoard = viewRoot.querySelector('.contacts-hierarchy-board');
  const tableBoard = viewRoot.querySelector('.contacts-table-board');
  if (hierarchyBoard) hierarchyBoard.classList.toggle('contacts-board--hidden', showTable);
  if (tableBoard) tableBoard.classList.toggle('contacts-board--hidden', !showTable);
  if (!showTable) scheduleHierarchyLinesDraw();
}

function collectTreeLevels(root) {
  const levels = [];
  const queue = [{ node: root, depth: 0 }];
  while (queue.length) {
    const current = queue.shift();
    if (!levels[current.depth]) levels[current.depth] = [];
    levels[current.depth].push(current.node);
    for (const child of current.node.children) {
      queue.push({ node: child, depth: current.depth + 1 });
    }
  }
  return levels;
}

function renderHierarchyNode(node, kind) {
  if (kind === 'accounts') {
    const row = node.item || {};
    const parentText = row.parentAccountName ? String(row.parentAccountName) : 'Top-level account';
    const updatedText = row.updatedAt ? `Updated ${new Date(row.updatedAt).toLocaleString()}` : 'No update time';
    const docLinksHtml = renderRecordDocumentLinksHtml(row, 'record-doc-links account-doc-links');
    return `
      <article class="hierarchy-node" data-node-id="${escapeHtml(node.id)}" data-parent-id="${escapeHtml(node.parent ? node.parent.id : '')}">
        <h4>${escapeHtml(node.label)}</h4>
        <div>Parent: ${escapeHtml(parentText)}</div>
        ${docLinksHtml}
        <div class="meta">${escapeHtml(updatedText)}</div>
      </article>
    `;
  }

  if (kind === 'contacts') {
    if (!node.item) {
      return `
        <article class="hierarchy-node hierarchy-root-node contact-node" data-node-id="${escapeHtml(node.id)}" data-parent-id="">
          <h4>${escapeHtml(node.label)}</h4>
          <div class="meta">Account</div>
        </article>
      `;
    }
    const row = node.item;
    const contactId = String(row._id || row.id || row.contactId || '').trim();
    const updatedText = formatContactUpdatedAt(row.updatedAt);
    const workloadTagsHtml = renderContactWorkloadTagsHtml(row);
    const docLinksHtml = renderRecordDocumentLinksHtml(row, 'record-doc-links contact-doc-links');
    const extraInfoHtml = buildContactMoreInfoHtml(row);
    const linkedInHeaderActionHtml = renderContactLinkedInHeaderAction(row);
    const deleteButtonHtml = contactId
      ? `<button type="button" class="contact-delete-btn" data-contact-id="${escapeHtml(contactId)}" data-contact-name="${escapeHtml(node.label)}">Delete</button>`
      : '';
    return `
      <article class="hierarchy-node contact-node contact-person-node" data-node-id="${escapeHtml(node.id)}" data-parent-id="${escapeHtml(node.parent ? node.parent.id : '')}">
        <div class="contact-card-header">
          <h4>${escapeHtml(node.label)}</h4>
          ${linkedInHeaderActionHtml}
        </div>
        <div>Title: ${escapeHtml(row.title || 'Unknown')}</div>
        <div>Email: ${escapeHtml(row.email || 'N/A')}</div>
        ${workloadTagsHtml}
        ${docLinksHtml}
        <details class="contact-more">
          <summary>More</summary>
          <div class="contact-more-body">${extraInfoHtml}</div>
        </details>
        ${deleteButtonHtml}
        <div class="meta">${escapeHtml(updatedText)}</div>
      </article>
    `;
  }

  return '';
}

function renderHierarchyForest(roots, kind) {
  if (kind === 'contacts') {
    return renderContactHierarchyForest(roots);
  }
  const treeHtml = roots.map((root, index) => {
    const levels = collectTreeLevels(root);
    const levelsHtml = levels.map((levelNodes, levelIndex) => `
      <div class="hierarchy-level hierarchy-level-${levelIndex}">
        ${levelNodes.map((node) => renderHierarchyNode(node, kind)).join('')}
      </div>
    `).join('');
    return `
      <section class="hierarchy-tree" data-tree-index="${index}">
        <svg class="hierarchy-lines" aria-hidden="true"></svg>
        <div class="hierarchy-levels">
          ${levelsHtml}
        </div>
      </section>
    `;
  }).join('');
  return `<div class="hierarchy-board">${treeHtml}</div>`;
}

function renderContactHierarchyBranch(node) {
  const children = Array.isArray(node.children) ? node.children : [];
  const childrenHtml = children.length
    ? `<div class="contact-subtree-children">${children.map((child) => renderContactHierarchyBranch(child)).join('')}</div>`
    : '';
  return `
    <div class="contact-subtree" data-node-branch-id="${escapeHtml(node.id)}">
      <div class="contact-subtree-node">
        ${renderHierarchyNode(node, 'contacts')}
      </div>
      ${childrenHtml}
    </div>
  `;
}

function renderContactHierarchyForest(roots) {
  return renderContactsHierarchyBoard(roots);
}

function drawHierarchyLinesForTree(treeEl) {
  const svg = treeEl.querySelector('.hierarchy-lines');
  if (!svg) return;
  const nodes = Array.from(treeEl.querySelectorAll('.hierarchy-node[data-node-id]'));
  const byId = new Map(nodes.map((node) => [node.dataset.nodeId, node]));
  const rect = treeEl.getBoundingClientRect();
  const contentEl = treeEl.querySelector('.hierarchy-levels');
  const contentRect = contentEl ? contentEl.getBoundingClientRect() : rect;
  const canvasWidth = Math.max(
    Math.ceil(treeEl.scrollWidth),
    Math.ceil(contentRect.right - rect.left + treeEl.scrollLeft),
    Math.ceil(rect.width)
  );
  const canvasHeight = Math.max(
    Math.ceil(treeEl.scrollHeight),
    Math.ceil(contentRect.bottom - rect.top + treeEl.scrollTop),
    Math.ceil(rect.height)
  );

  while (svg.firstChild) svg.removeChild(svg.firstChild);
  svg.style.width = `${Math.max(1, canvasWidth)}px`;
  svg.style.height = `${Math.max(1, canvasHeight)}px`;
  svg.setAttribute('width', String(Math.max(1, canvasWidth)));
  svg.setAttribute('height', String(Math.max(1, canvasHeight)));
  svg.setAttribute('viewBox', `0 0 ${Math.max(1, canvasWidth)} ${Math.max(1, canvasHeight)}`);

  for (const childNode of nodes) {
    const parentId = String(childNode.dataset.parentId || '').trim();
    if (!parentId) continue;
    const parentNode = byId.get(parentId);
    if (!parentNode) continue;

    const parentRect = parentNode.getBoundingClientRect();
    const childRect = childNode.getBoundingClientRect();
    const startX = parentRect.left + (parentRect.width / 2) - rect.left + treeEl.scrollLeft;
    const startY = parentRect.bottom - rect.top + treeEl.scrollTop;
    const endX = childRect.left + (childRect.width / 2) - rect.left + treeEl.scrollLeft;
    const endY = childRect.top - rect.top + treeEl.scrollTop;
    const controlOffset = Math.max(24, (endY - startY) * 0.45);

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute(
      'd',
      `M ${startX} ${startY} C ${startX} ${startY + controlOffset}, ${endX} ${endY - controlOffset}, ${endX} ${endY}`
    );
    path.setAttribute('class', 'hierarchy-connector');
    svg.appendChild(path);
  }
}

function drawHierarchyLines() {
  const trees = cardsContainerEl.querySelectorAll('.hierarchy-tree');
  trees.forEach((treeEl) => drawHierarchyLinesForTree(treeEl));
}

function scheduleHierarchyLinesDraw() {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      drawHierarchyLines();
    });
  });
}

function layoutMilestoneConnectors(viewRoot = cardsContainerEl.querySelector('.milestones-view')) {
  if (!viewRoot) return;
  const plotEl = viewRoot.querySelector('.milestone-year-plot');
  const trackEl = viewRoot.querySelector('.milestone-year-track');
  const connectorsLayerEl = viewRoot.querySelector('.milestone-year-connectors');
  if (!trackEl || !plotEl || !connectorsLayerEl) return;
  const itemEls = Array.from(viewRoot.querySelectorAll('.milestone-year-item'));
  const connectorEls = Array.from(viewRoot.querySelectorAll('.milestone-year-connector-line'));
  const connectorById = new Map();
  connectorEls.forEach((connectorEl) => {
    const id = String(connectorEl.getAttribute('data-milestone-connector-id') || '').trim();
    if (!id) return;
    connectorById.set(id, connectorEl);
  });

  const lineGapPx = 18;
  const rowGapPx = 14;
  const collisionGapPx = 12;

  const stackSideItems = (placement) => {
    const sideItems = itemEls.filter((itemEl) => {
      return (itemEl.getAttribute('data-milestone-placement') === 'bottom' ? 'bottom' : 'top') === placement;
    });
    if (!sideItems.length) return { extentPx: 0 };

    sideItems.sort((a, b) => {
      const aRect = a.getBoundingClientRect();
      const bRect = b.getBoundingClientRect();
      return aRect.left - bRect.left;
    });

    const levelsLastRight = [];
    const itemLevels = new Map();
    for (const itemEl of sideItems) {
      const rect = itemEl.getBoundingClientRect();
      let level = 0;
      while (level < levelsLastRight.length && rect.left < (levelsLastRight[level] + collisionGapPx)) {
        level += 1;
      }
      itemLevels.set(itemEl, level);
      levelsLastRight[level] = rect.right;
    }

    const levelHeights = [];
    for (const itemEl of sideItems) {
      const level = itemLevels.get(itemEl) || 0;
      const cardEl = itemEl.querySelector('.milestone-card');
      const cardHeight = cardEl ? cardEl.getBoundingClientRect().height : itemEl.getBoundingClientRect().height;
      levelHeights[level] = Math.max(levelHeights[level] || 0, cardHeight);
    }

    const levelOffsets = [];
    let runningOffset = lineGapPx;
    for (let level = 0; level < levelHeights.length; level += 1) {
      levelOffsets[level] = runningOffset;
      runningOffset += (levelHeights[level] || 0) + rowGapPx;
    }

    let extentPx = 0;
    for (const itemEl of sideItems) {
      const level = itemLevels.get(itemEl) || 0;
      const offsetPx = levelOffsets[level] || lineGapPx;
      if (placement === 'top') {
        itemEl.style.bottom = `calc(50% + ${offsetPx}px)`;
        itemEl.style.top = 'auto';
      } else {
        itemEl.style.top = `calc(50% + ${offsetPx}px)`;
        itemEl.style.bottom = 'auto';
      }
      const cardEl = itemEl.querySelector('.milestone-card');
      const cardHeight = cardEl ? cardEl.getBoundingClientRect().height : itemEl.getBoundingClientRect().height;
      extentPx = Math.max(extentPx, offsetPx + cardHeight);
    }
    return { extentPx };
  };

  const topStack = stackSideItems('top');
  const bottomStack = stackSideItems('bottom');
  const desiredPlotHeight = Math.max(680, Math.ceil(topStack.extentPx + bottomStack.extentPx + 140));
  plotEl.style.minHeight = `${desiredPlotHeight}px`;

  // Recompute geometry after dynamic plot height changes so connector lines
  // target the true rendered center timeline (especially with deeper stacks).
  const refreshedTrackRect = trackEl.getBoundingClientRect();
  const refreshedPlotRect = plotEl.getBoundingClientRect();
  const timelineY = refreshedTrackRect.top + (refreshedTrackRect.height / 2);
  const timelineYRel = timelineY - refreshedPlotRect.top;

  itemEls.forEach((itemEl) => {
    const connectorId = String(itemEl.getAttribute('data-milestone-connector-id') || '').trim();
    const connectorEl = connectorId ? connectorById.get(connectorId) : null;
    const cardEl = itemEl.querySelector('.milestone-card');
    if (!connectorEl || !cardEl) return;
    const cardRect = cardEl.getBoundingClientRect();
    const placement = itemEl.getAttribute('data-milestone-placement') === 'bottom' ? 'bottom' : 'top';
    const cardTopRel = cardRect.top - refreshedPlotRect.top;
    const cardBottomRel = cardRect.bottom - refreshedPlotRect.top;
    const connectorHeight = placement === 'top'
      ? Math.max(10, Math.round(timelineYRel - cardBottomRel))
      : Math.max(10, Math.round(cardTopRel - timelineYRel));
    const connectorTop = placement === 'top'
      ? Math.round(cardBottomRel)
      : Math.round(timelineYRel);
    connectorEl.classList.toggle('milestone-year-connector-line--from-top', placement === 'top');
    connectorEl.classList.toggle('milestone-year-connector-line--from-bottom', placement === 'bottom');
    connectorEl.style.top = `${connectorTop}px`;
    connectorEl.style.height = `${connectorHeight}px`;
  });
}

function scheduleMilestoneConnectorLayout() {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      layoutMilestoneConnectors();
    });
  });
}

window.addEventListener('resize', () => {
  if (state.currentView === 'accounts' || state.currentView === 'contacts') {
    scheduleHierarchyLinesDraw();
    return;
  }
  if (state.currentView === 'milestones') {
    scheduleMilestoneConnectorLayout();
  }
});

async function renderHome() {
  viewTitleEl.textContent = 'Home';
  const [snapshotData, tasksData, workloadsData, contactsData] = await Promise.all([
    apiGet('/api/dashboard/snapshot'),
    apiGet('/api/tasks/open?limit=500'),
    apiGet('/api/workloads?limit=500'),
    apiGet('/api/contacts?limit=500')
  ]);
  const cards = snapshotData.cards || {};

  const openTasks = Array.isArray(tasksData.openTasks) ? tasksData.openTasks : [];
  const tasksByList = new Map();
  for (const task of openTasks) {
    const listName = String(task?.taskListName || '').trim() || 'Unknown List';
    tasksByList.set(listName, (tasksByList.get(listName) || 0) + 1);
  }
  const taskListCounts = Array.from(tasksByList.entries())
    .map(([taskListName, count]) => ({ taskListName, count }))
    .sort((a, b) => (b.count - a.count) || a.taskListName.localeCompare(b.taskListName, undefined, { sensitivity: 'base' }));

  const workloads = Array.isArray(workloadsData.workloads) ? workloadsData.workloads : [];
  const workloadsByStage = new Map();
  for (const row of workloads) {
    const stageName = canonicalWorkloadStageGroupKey(row);
    if (!workloadsByStage.has(stageName)) workloadsByStage.set(stageName, []);
    workloadsByStage.get(stageName).push(row);
  }
  const stageSummaries = Array.from(workloadsByStage.entries())
    .map(([stageName, rows]) => ({
      stageName,
      opsCount: rows.length,
      amountTotal: sumWorkloadArrForRows(rows)
    }))
    .sort((a, b) => compareWorkloadStageGroupKeys(a.stageName, b.stageName));

  const contacts = Array.isArray(contactsData.contacts) ? contactsData.contacts : [];
  const { byAccount: contactsByAccount, sortedAccounts } = buildContactRowsByAccount(contacts);
  const contactsByAccountSummary = sortedAccounts
    .map((accountName) => ({
      accountName,
      count: (contactsByAccount.get(accountName) || []).length
    }))
    .sort((a, b) => (b.count - a.count) || a.accountName.localeCompare(b.accountName, undefined, { sensitivity: 'base' }));

  const taskListsHtml = renderHomeMetricLines(
    taskListCounts,
    (entry) => `<span class="home-metric-label">${escapeHtml(entry.taskListName)}</span><span class="home-metric-value">${entry.count}</span>`,
    'No open tasks found.'
  );
  const workloadsHtml = renderHomeMetricLines(
    stageSummaries,
    (entry) => `<span class="home-metric-label">${escapeHtml(entry.stageName)}</span><span class="home-metric-value">${entry.opsCount} ops · ${escapeHtml(formatArrValue(entry.amountTotal) || '$0')}</span>`,
    'No workloads found.'
  );
  const contactsHtml = renderHomeMetricLines(
    contactsByAccountSummary,
    (entry) => `<span class="home-metric-label">${escapeHtml(entry.accountName)}</span><span class="home-metric-value">${entry.count}</span>`,
    'No contacts found.'
  );
  const totalsHtml = `<ul class="home-metric-list">
    <li><span class="home-metric-label">Open Tasks</span><span class="home-metric-value">${Number(cards.openTasks?.total || 0)}</span></li>
    <li><span class="home-metric-label">Workloads</span><span class="home-metric-value">${Number(cards.workloads?.total || 0)}</span></li>
    <li><span class="home-metric-label">Accounts</span><span class="home-metric-value">${Number(cards.accounts?.total || 0)}</span></li>
    <li><span class="home-metric-label">Contacts</span><span class="home-metric-value">${Number(cards.contacts?.total || 0)}</span></li>
  </ul>`;

  setCardsFromHtml(`<div class="home-columns-view">
    ${homeColumnCardHtml('Open Tasks', 'By task list', taskListsHtml)}
    ${homeColumnCardHtml('Workloads', 'Ops count and amount by stage', workloadsHtml)}
    ${homeColumnCardHtml('Contacts', 'By account', contactsHtml)}
    ${homeColumnCardHtml('Snapshot Totals', 'Current dashboard totals', totalsHtml)}
  </div>`);
}

async function renderTasks() {
  viewTitleEl.textContent = 'Open Tasks';
  const [tasksData, workloadsData] = await Promise.all([
    apiGet('/api/tasks/open?limit=200'),
    apiGet('/api/workloads?limit=500')
  ]);
  const data = tasksData;
  const items = Array.isArray(data.openTasks) ? data.openTasks : [];
  const workloads = Array.isArray(workloadsData.workloads) ? workloadsData.workloads : [];
  const workloadNameById = new Map();
  for (const row of workloads) {
    const id = String(row?._id || row?.id || '').trim();
    if (!id) continue;
    const label = String(row?.name || '').trim() || id;
    workloadNameById.set(id, label);
  }
  if (!items.length) {
    setCardsFromHtml(cardHtml('No Open Tasks', 'No open tasks found.', 'Tasks'));
    return;
  }
  const byList = new Map();
  for (const task of items) {
    const listId = String(task.taskListId || 'unknown-list');
    if (!byList.has(listId)) {
      byList.set(listId, {
        taskListName: task.taskListName || 'Unknown List',
        owner: task.owner || null,
        tasks: []
      });
    }
    byList.get(listId).tasks.push(task);
  }

  const sortedListEntries = Array.from(byList.entries()).sort((a, b) => {
    const nameA = String(a[1].taskListName || '').trim();
    const nameB = String(b[1].taskListName || '').trim();
    const cmp = nameA.localeCompare(nameB, undefined, { sensitivity: 'base' });
    return cmp !== 0 ? cmp : String(a[0]).localeCompare(String(b[0]));
  });

  const filtersHtml = sortedListEntries
    .map(([listId, listData]) => {
      const n = listData.tasks.length;
      const suffix = n === 1 ? '' : 's';
      const title = String(listData.taskListName || 'Unknown List').trim() || 'Unknown List';
      const checked = !taskListFiltersState.hiddenListIds.has(String(listId));
      return `
    <label class="task-list-filter-item">
      <input type="checkbox" class="task-list-filter-cb" data-task-list-filter-id="${escapeHtml(String(listId))}" ${checked ? 'checked' : ''}>
      <span>${escapeHtml(title)} (${n} open task${suffix})</span>
    </label>`;
    })
    .join('');

  const listColumns = sortedListEntries.map(([listId, listData]) => {
    const filteredOutClass = taskListFiltersState.hiddenListIds.has(String(listId))
      ? ' task-list-column--filtered-out'
      : '';
    const groups = new Map();
    for (const task of listData.tasks) {
      const key = priorityLabel(task.priority);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(task);
    }

    const sortedPriorities = Array.from(groups.keys()).sort((a, b) => {
      const rankDiff = priorityRank(a) - priorityRank(b);
      return rankDiff !== 0 ? rankDiff : a.localeCompare(b);
    });

    const groupHtml = sortedPriorities.map((priority) => {
      const priorityTasks = groups.get(priority).slice().sort((a, b) => {
        return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
      });
      const taskHtml = priorityTasks.map((task) => {
        const workloadId = String(task.workloadId || '').trim();
        const workloadLabel = workloadId ? (workloadNameById.get(workloadId) || workloadId) : '';
        const workloadStyle = workloadId ? workloadTagStyle(workloadId) : null;
        const workloadTagsHtml = workloadStyle
          ? `<div class="task-workload-tags"><span class="task-tag workload-tag" style="background:${escapeHtml(workloadStyle.background)};border-color:${escapeHtml(workloadStyle.border)};color:${escapeHtml(workloadStyle.text)}">${escapeHtml(workloadLabel)}</span></div>`
          : '';
        const taskLinks = extractRecordDocumentLinks(task);
        const taskLinkTagsHtml = taskLinks.length
          ? `<div class="task-link-tags">${taskLinks.map((link) => `<a class="task-tag task-link-tag" href="${escapeHtml(link.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.name)}</a>`).join('')}</div>`
          : '';
        const ownerTrim = String(task.taskOwner || task.owner || '').trim();
        const ownerRowHtml = ownerTrim
          ? `<div class="task-board-detail">Owner: ${escapeHtml(ownerTrim)}</div>`
          : '';
        const dueLine = task.dueDate
          ? `<div class="task-board-due"><strong>${escapeHtml(formatTaskDueDate(task.dueDate))}</strong></div>`
          : '';
        const taskId = String(task.taskId || '').trim();
        const taskListId = String(task.taskListId || '').trim();
        const taskDeleteButtonHtml = taskId && taskListId
          ? `<button type="button" class="task-delete-btn" aria-label="Delete task" title="Delete task" data-task-id="${escapeHtml(taskId)}" data-task-list-id="${escapeHtml(taskListId)}" data-task-name="${escapeHtml(String(task.task || 'Untitled task'))}">&times;</button>`
          : '';
        const taskItemClass = taskLinks.length
          ? 'task-board-item task-board-item--with-links'
          : 'task-board-item';
        return `
          <article class="${taskItemClass}">
            <h4>${escapeHtml(task.task || 'Untitled task')}</h4>
            <div class="task-board-detail">Status: ${escapeHtml(task.status || 'open')}</div>
            ${ownerRowHtml}
            ${workloadTagsHtml}
            ${taskLinkTagsHtml}
            ${taskDeleteButtonHtml}
            <div class="meta task-board-updated">${dueLine}<div>${escapeHtml(formatTaskUpdatedAt(task.updatedAt))}</div></div>
          </article>
        `;
      }).join('');
      return `
        <section class="priority-group">
          <h5>${escapeHtml(priority)} (${priorityTasks.length})</h5>
          ${taskHtml}
        </section>
      `;
    }).join('');

    const listOwnerTrim = String(listData.owner || '').trim();
    const listOwnerPrefix = listOwnerTrim ? `${escapeHtml(listOwnerTrim)} — ` : '';
    return `
      <section class="task-list-column${filteredOutClass}" data-task-list-filter-id="${escapeHtml(String(listId))}">
        <header class="task-list-header">
          <h3>${escapeHtml(listData.taskListName)}</h3>
          <div class="meta">${listOwnerPrefix}${listData.tasks.length} open</div>
        </header>
        ${groupHtml}
      </section>
    `;
  });

  setCardsFromHtml(`<div class="tasks-view">
    <div class="task-list-filters" role="group" aria-label="Show tasks by list">
      <span class="task-list-filters-heading">Task lists</span>
      <div class="task-list-filters-chips">${filtersHtml}</div>
    </div>
    <div class="task-lists-board">${listColumns.join('')}</div>
  </div>`);
}

async function renderWorkloads() {
  viewTitleEl.textContent = 'Workloads';
  const [data, tasksData] = await Promise.all([
    apiGet('/api/workloads?limit=200'),
    apiGet('/api/tasks/open?limit=500')
  ]);
  const items = Array.isArray(data.workloads) ? data.workloads : [];
  const openTasks = Array.isArray(tasksData.openTasks) ? tasksData.openTasks : [];
  const tasksByWorkloadId = groupOpenTasksByWorkloadId(openTasks);
  if (!items.length) {
    setCardsFromHtml(cardHtml('No Workloads', 'No workloads found.', 'Workloads'));
    return;
  }
  const byAccount = new Map();
  for (const row of items) {
    const accountName = String(row?.accountName || '').trim() || 'Unknown';
    if (!byAccount.has(accountName)) byAccount.set(accountName, []);
    byAccount.get(accountName).push(row);
  }

  const sortedAccounts = Array.from(byAccount.keys()).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  const filtersHtml = sortedAccounts
    .map((accountName, idx) => {
      const n = (byAccount.get(accountName) || []).length;
      const suffix = n === 1 ? '' : 's';
      return `
    <label class="workload-account-filter-item">
      <input type="checkbox" class="workload-account-filter-cb" data-workload-filter-idx="${idx}" checked>
      <span>${escapeHtml(accountName)} (${n} workload${suffix})</span>
    </label>`;
    })
    .join('');
  const accountColumns = sortedAccounts.map((accountName, accountIdx) => {
    const accountRows = byAccount.get(accountName) || [];
    const accountArrTotal = sumWorkloadArrForRows(accountRows);
    const accountArrTotalHtml = formatArrValue(accountArrTotal);
    const byStage = new Map();
    for (const row of accountRows) {
      const key = canonicalWorkloadStageGroupKey(row);
      if (!byStage.has(key)) byStage.set(key, []);
      byStage.get(key).push(row);
    }
    const stageKeys = Array.from(byStage.keys()).sort(compareWorkloadStageGroupKeys);
    const stageSectionsHtml = stageKeys.map((stageKey) => {
      const rows = (byStage.get(stageKey) || []).slice().sort((a, b) => {
        return String(b?.updatedAt || '').localeCompare(String(a?.updatedAt || ''));
      });
      const cardsHtml = rows.map((row) => {
        const arrText = formatArrValue(extractWorkloadArr(row));
        const stageText = extractWorkloadStage(row);
        const contactNames = extractWorkloadContactNames(row);
        const contactTagsHtml = contactNames.length
          ? `<div class="workload-contact-tags">${contactNames.map((name) => `<span class="task-tag">${escapeHtml(name)}</span>`).join('')}</div>`
          : '';
        const salesforceHref = extractSalesforceLink(row);
        const salesforceActionHtml = salesforceHref ? buildWorkloadSalesforceLinkHtml(salesforceHref) : '';
        const docLinksHtml = renderRecordDocumentLinksHtml(row, 'record-doc-links workload-doc-links');
        const moreInfoHtml = buildWorkloadMoreInfoHtml(row);
        const cleanDescription = cleanWorkloadDescriptionText(row.description || row.notes || '');
        const detailsText = summarize(cleanDescription, 220);
        const workloadRowId = String(row._id || row.id || '').trim();
        const { cardClassSuffix, barHtml } = buildWorkloadOpenTaskBarHtml(workloadRowId, tasksByWorkloadId);
        return `
        <article class="card workload-card${cardClassSuffix}">
          ${arrText ? `<div class="workload-arr">${escapeHtml(arrText)}</div>` : ''}
          <h4>${escapeHtml(row.name || 'Untitled workload')}</h4>
          <div class="workload-account-subtitle">${escapeHtml(accountName)}</div>
          ${stageText ? (() => {
            const stageStyle = workloadStageTagStyle(stageText);
            return `<div><span class="workload-stage-pill" style="background:${escapeHtml(stageStyle.background)};border-color:${escapeHtml(stageStyle.border)};color:${escapeHtml(stageStyle.text)}">${escapeHtml(stageText)}</span></div>`;
          })() : ''}
          ${contactTagsHtml}
          ${docLinksHtml}
          <details class="workload-more">
            <summary>More</summary>
            <div class="workload-more-body">
              ${detailsText ? `<div class="workload-summary">${escapeHtml(detailsText)}</div>` : '<div class="workload-extra-empty">No description provided.</div>'}
              ${moreInfoHtml}
            </div>
          </details>
          <div class="workload-footer-actions">
            ${salesforceActionHtml}
            <div class="meta workload-updated">${escapeHtml(formatWorkloadUpdatedAt(row.updatedAt))}</div>
          </div>
          ${barHtml}
        </article>
      `;
      }).join('');
      const stageArrTotal = sumWorkloadArrForRows(rows);
      const stageArrLabel = formatArrValue(stageArrTotal);
      return `
        <div class="workload-stage-group">
          <h5 class="workload-stage-group-heading" title="Sum of ARR for workloads in this stage">
            <span class="workload-stage-group-title">${escapeHtml(stageKey)} (${rows.length})</span>
            <span class="workload-stage-group-arr-sum">${escapeHtml(stageArrLabel || '$0')}</span>
          </h5>
          ${cardsHtml}
        </div>
      `;
    }).join('');
    return `
      <section class="workload-account-column" data-workload-filter-idx="${accountIdx}">
        <header class="workload-account-header">
          <div class="workload-account-title-row">
            <h3>${escapeHtml(accountName)}</h3>
            <div class="workload-account-arr-block" title="Total ARR across workloads in this account">
              <span class="workload-account-arr-caption">Total ARR</span>
              <span class="workload-account-total-arr">${escapeHtml(accountArrTotalHtml || '$0')}</span>
            </div>
          </div>
          <div class="meta">${accountRows.length} workload${accountRows.length === 1 ? '' : 's'}</div>
        </header>
        <div class="workload-account-list">
          ${stageSectionsHtml}
        </div>
      </section>
    `;
  }).join('');

  setCardsFromHtml(`<div class="workloads-view">
    <div class="workload-account-filters" role="group" aria-label="Show workloads by account">
      <span class="workload-account-filters-heading">Accounts</span>
      <div class="workload-account-filters-chips">${filtersHtml}</div>
    </div>
    <div class="workload-accounts-board">${accountColumns}</div>
  </div>`);
}

async function renderAccounts() {
  viewTitleEl.textContent = 'Accounts';
  const data = await apiGet('/api/accounts?limit=200');
  const items = Array.isArray(data.accounts) ? data.accounts : [];
  if (!items.length) {
    setCardsFromHtml(cardHtml('No Accounts', 'No accounts found.', 'Accounts'));
    return;
  }
  const roots = buildAccountForest(items);
  setCardsFromHtml(renderHierarchyForest(roots, 'accounts'));
  scheduleHierarchyLinesDraw();
}

async function renderInitiatives() {
  viewTitleEl.textContent = 'Initiatives';
  const data = await apiGet('/api/initiatives?limit=200');
  const items = Array.isArray(data.initiatives) ? data.initiatives : [];
  if (!items.length) {
    setCardsFromHtml(cardHtml('No Initiatives', 'No initiatives found.', 'Initiatives'));
    return;
  }
  const cards = items
    .map((row) => {
      const title = escapeHtml(row.initiativeName || 'Untitled');
      const descFull = String(row.initiativeDescription || '').trim();
      let descBlock = '';
      if (descFull) {
        const escFull = escapeHtml(descFull);
        const peek = escapeHtml(summarize(descFull, 140));
        descBlock = `
        <details class="initiative-desc-expand">
          <summary class="initiative-desc-expand-summary">
            <span class="initiative-desc-expand-title">Description</span>
            <span class="initiative-desc-expand-peek">${peek}</span>
          </summary>
          <div class="initiative-desc-full">${escFull}</div>
        </details>`;
      }
      const accounts = Array.isArray(row.accounts) ? row.accounts : [];
      const accountTags = accounts
        .map(
          (a) =>
            `<span class="workload-stage-pill" style="background:#f1f5f9;border-color:#e2e8f0;color:#334155">${escapeHtml(a.accountName || a.accountId || '')}</span>`
        )
        .join(' ');
      const targeted = row.targetedErr != null ? formatArrValue(row.targetedErr) : '';
      const discovered = row.errDiscovered != null ? formatArrValue(row.errDiscovered) : '';
      const contactsList = Array.isArray(row.initiativeContacts) ? row.initiativeContacts : [];
      const workloadsList = Array.isArray(row.initiativeWorkloads) ? row.initiativeWorkloads : [];
      const contactsTagsHtml = contactsList.length
        ? `<div class="initiative-contact-cards">${contactsList.map((c) => renderInitiativeContactMiniCard(c)).join('')}</div>`
        : '<div class="meta initiative-empty-list">No contacts linked.</div>';
      const workloadsTagsHtml = workloadsList.length
        ? `<div class="workload-contact-tags">${workloadsList
            .map((w, idx) => {
              const label = String(w?.name || w?.workloadId || '').trim() || 'Workload';
              const style = initiativeWorkloadPillInlineStyle(idx);
              return `<span class="workload-stage-pill" style="${style}">${escapeHtml(label)}</span>`;
            })
            .join('')}</div>`
        : '<div class="meta initiative-empty-list">No workloads linked.</div>';
      return `
      <article class="card initiative-card">
        <h4>${title}</h4>
        ${descBlock}
        ${accounts.length ? `<div class="workload-contact-tags initiative-account-tags">${accountTags}</div>` : ''}
        <div class="meta initiative-err-block">
          ${targeted ? `<div>Targeted ERR: ${escapeHtml(targeted)}</div>` : ''}
          <div>${discovered ? `ERR discovered: ${escapeHtml(discovered)}` : 'ERR discovered: —'}</div>
        </div>
        <div class="initiative-linked">
          <div class="meta initiative-section-label">Contacts</div>
          ${contactsTagsHtml}
        </div>
        <div class="initiative-linked">
          <div class="meta initiative-section-label">Workloads</div>
          ${workloadsTagsHtml}
        </div>
      </article>`;
    })
    .join('');
  setCardsFromHtml(`<div class="initiatives-view">${cards}</div>`);
}

async function renderContacts() {
  viewTitleEl.textContent = 'Contacts';
  const data = await apiGet('/api/contacts?limit=200');
  const items = Array.isArray(data.contacts) ? data.contacts : [];
  if (!items.length) {
    setCardsFromHtml(cardHtml('No Contacts', 'No contacts found.', 'Contacts'));
    return;
  }
  const roots = buildContactsForest(items);
  const { byAccount, sortedAccounts } = buildContactRowsByAccount(items);
  sortedAccounts.forEach((accountName) => {
    if (!contactsViewState.knownAccounts.has(accountName)) {
      contactsViewState.knownAccounts.add(accountName);
      contactsViewState.selectedAccounts.add(accountName);
    }
  });
  for (const knownAccount of Array.from(contactsViewState.knownAccounts)) {
    if (!sortedAccounts.includes(knownAccount)) {
      contactsViewState.knownAccounts.delete(knownAccount);
      contactsViewState.selectedAccounts.delete(knownAccount);
    }
  }
  if (!contactsViewState.selectedColumns.size) {
    CONTACT_DEFAULT_TABLE_COLUMNS.forEach((column) => contactsViewState.selectedColumns.add(column));
  }
  const columnOptions = buildContactTableColumnOptions(items);
  for (const key of Array.from(contactsViewState.selectedColumns)) {
    if (!columnOptions.some((column) => column.key === key)) contactsViewState.selectedColumns.delete(key);
  }
  if (!contactsViewState.selectedColumns.size) {
    CONTACT_DEFAULT_TABLE_COLUMNS.forEach((column) => contactsViewState.selectedColumns.add(column));
  }

  const filtersHtml = renderContactAccountFiltersHtml(sortedAccounts, byAccount);
  const columnFiltersHtml = renderContactColumnsFiltersHtml(columnOptions);
  const hierarchyBoardHtml = renderContactsHierarchyBoard(roots);
  const tableBoardHtml = renderContactsTableBoard(sortedAccounts, byAccount, columnOptions);
  setCardsFromHtml(`<div class="contacts-view">
    <div class="contacts-controls">
      <div class="contacts-view-toggle" role="radiogroup" aria-label="Contact view mode">
        <label class="contacts-view-toggle-item">
          <input type="radio" name="contacts-view-mode" class="contacts-view-mode-cb" value="hierarchy" ${contactsViewState.mode === 'hierarchy' ? 'checked' : ''}>
          <span>Hierarchy</span>
        </label>
        <label class="contacts-view-toggle-item">
          <input type="radio" name="contacts-view-mode" class="contacts-view-mode-cb" value="table" ${contactsViewState.mode === 'table' ? 'checked' : ''}>
          <span>Table</span>
        </label>
      </div>
      <div class="contact-account-filters" role="group" aria-label="Show contacts by account">
        <span class="contact-account-filters-heading">Accounts</span>
        <div class="contact-account-filters-chips">${filtersHtml}</div>
      </div>
      <div class="contact-table-column-filters" role="group" aria-label="Choose table columns">
        <span class="contact-table-column-filters-heading">Table columns</span>
        <div class="contact-table-column-filters-chips">${columnFiltersHtml}</div>
      </div>
    </div>
    ${hierarchyBoardHtml}
    ${tableBoardHtml}
  </div>`);

  cardsContainerEl.querySelectorAll('.contact-account-filter-cb').forEach((cb) => {
    const key = String(cb.getAttribute('data-contact-filter-key') || '');
    cb.checked = contactsViewState.selectedAccounts.has(key);
  });
  cardsContainerEl.querySelectorAll('.contact-account-section').forEach((section) => {
    const key = String(section.getAttribute('data-contact-filter-key') || '');
    section.classList.toggle('contact-account-section--filtered-out', !contactsViewState.selectedAccounts.has(key));
  });
  applyContactsViewState(cardsContainerEl.querySelector('.contacts-view'));

  const details = cardsContainerEl.querySelectorAll('.contact-more');
  details.forEach((detailsEl) => {
    detailsEl.addEventListener('toggle', () => {
      if (contactsViewState.mode === 'table') return;
      scheduleHierarchyLinesDraw();
    });
  });
  if (contactsViewState.mode !== 'table') scheduleHierarchyLinesDraw();
}

async function renderMilestones() {
  viewTitleEl.textContent = 'Milestones';
  const data = await apiGet('/api/milestones?limit=500');
  const items = Array.isArray(data.milestones) ? data.milestones : [];
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const currentYear = today.getUTCFullYear();
  const yearStartMs = Date.UTC(currentYear, 0, 1);
  const yearEndMs = Date.UTC(currentYear, 11, 31);
  const yearSpanMs = Math.max(1, yearEndMs - yearStartMs);
  const milestones = items
    .map((row) => {
      const dateObj = parseMilestoneDateValue(row?.milestoneDate);
      if (!dateObj) return null;
      return { row, dateObj };
    })
    .filter(Boolean)
    .sort((a, b) => a.dateObj.getTime() - b.dateObj.getTime());
  const milestonesThisYear = milestones.filter(({ dateObj }) => dateObj.getUTCFullYear() === currentYear);
  const milestonesOutsideYearCount = milestones.length - milestonesThisYear.length;

  const monthTicksHtml = Array.from({ length: 12 }, (_unused, idx) => {
    const monthStartMs = Date.UTC(currentYear, idx, 1);
    const leftPct = computeMilestoneYearPointPct(new Date(monthStartMs), yearStartMs, yearSpanMs);
    const monthLabel = new Date(monthStartMs).toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' });
    return `
      <div class="milestone-year-month-tick" style="left:${leftPct}%">
        <span>${escapeHtml(monthLabel)}</span>
      </div>
    `;
  }).join('');

  const todayLeftPct = computeMilestoneYearPointPct(today, yearStartMs, yearSpanMs);
  const milestonesPrepared = milestonesThisYear.map(({ row, dateObj }, idx) => {
    const pointPct = computeMilestoneYearPointPct(dateObj, yearStartMs, yearSpanMs);
    const placement = idx % 2 === 0 ? 'top' : 'bottom';
    return { row, dateObj, idx, pointPct, placement };
  });

  const connectorsHtml = milestonesPrepared.map(({ idx, pointPct }) => {
    return `<div class="milestone-year-connector-line" data-milestone-connector-id="${idx}" style="left:${pointPct}%"></div>`;
  }).join('');

  const milestoneItemsHtml = milestonesPrepared.length
    ? milestonesPrepared.map(({ row, dateObj, idx, pointPct, placement }) => {
      const status = normalizeMilestoneStatusForDisplay(row?.status);
      const relativeText = formatMilestoneRelativeLabel(dateObj, today);
      const accountName = String(row?.accountName || '').trim();
      const narrText = formatArrValue(row?.narr);
      const workloadTagsHtml = extractMilestoneWorkloadTagsHtml(row?.workloadIds);
      const notes = Array.isArray(row?.notes) ? row.notes : [];
      const latestNote = notes.length ? notes[notes.length - 1] : null;
      const noteText = latestNote?.text ? summarize(latestNote.text, 160) : '';
      const noteMeta = latestNote ? formatNoteTimestamp(latestNote.updatedAt || latestNote.createdAt) : '';
      const descriptionText = row?.description ? summarize(String(row.description), 180) : '';
      return `
        <section class="milestone-year-item milestone-year-item--${placement}" data-milestone-placement="${placement}" data-milestone-connector-id="${idx}" style="left:${pointPct}%">
          <article class="card milestone-card">
            <div class="milestone-card-head">
              <div class="milestone-head-left">
                <h4 class="milestone-title">${escapeHtml(row?.name || 'Untitled milestone')}</h4>
                <div class="milestone-title-date">${escapeHtml(formatMilestoneDateLabel(dateObj))}${relativeText ? ` - ${escapeHtml(relativeText)}` : ''}</div>
              </div>
              <div class="milestone-head-right">
                <div class="milestone-narr-inline">${escapeHtml(narrText || '')}</div>
                <div class="milestone-status-row"><span class="milestone-status-pill ${milestoneStatusClass(status)}">${escapeHtml(status)}</span></div>
              </div>
            </div>
            ${accountName ? `<div class="milestone-account-line">${escapeHtml(accountName)}</div>` : ''}
            ${workloadTagsHtml}
            ${descriptionText ? `<div class="milestone-description">${escapeHtml(descriptionText)}</div>` : ''}
            ${noteText ? `<div class="milestone-note-preview"><div class="milestone-note-label">Latest note${noteMeta ? ` - ${escapeHtml(noteMeta)}` : ''}</div><div>${escapeHtml(noteText)}</div></div>` : ''}
          </article>
        </section>
      `;
    }).join('')
    : '<div class="milestone-year-empty">No milestones set in the current year.</div>';

  setCardsFromHtml(`<div class="milestones-view">
    <div class="milestones-meta-row">
      <span class="meta">${escapeHtml(String(currentYear))} timeline (Jan-Dec). ${milestonesOutsideYearCount > 0 ? `${milestonesOutsideYearCount} milestone${milestonesOutsideYearCount === 1 ? '' : 's'} outside this year are hidden.` : 'All milestones shown are in the current year.'}</span>
    </div>
    <div class="milestones-board">
      <div class="milestone-year-plot">
        <div class="milestone-year-track"></div>
        ${monthTicksHtml}
        <div class="milestone-today-marker" style="left:${todayLeftPct}%"><span>Today</span></div>
        <div class="milestone-year-connectors">${connectorsHtml}</div>
        <div class="milestone-year-items">
          ${milestoneItemsHtml}
        </div>
      </div>
    </div>
  </div>`);
  scheduleMilestoneConnectorLayout();
}

async function renderView(view) {
  state.currentView = view;
  const buttons = navIconsEl.querySelectorAll('.icon-btn');
  buttons.forEach((btn) => {
    if (btn.dataset.view === 'chat') return;
    const active = btn.dataset.view === view;
    btn.classList.toggle('active', active);
  });
  setCardsFromHtml(cardHtml('Loading', 'Loading data...', ''));
  try {
    if (view === 'tasks') return await renderTasks();
    if (view === 'workloads') return await renderWorkloads();
    if (view === 'milestones') return await renderMilestones();
    if (view === 'accounts') return await renderAccounts();
    if (view === 'contacts') return await renderContacts();
    if (view === 'initiatives') return await renderInitiatives();
    return await renderHome();
  } catch (err) {
    setCardsFromHtml(cardHtml('Error', escapeHtml(err.message || String(err)), 'Request failed'));
  }
}

function renderChatMessages() {
  chatMessagesEl.innerHTML = '';
  for (const msg of state.chatMessages) {
    const div = document.createElement('div');
    div.className = `msg ${msg.role === 'user' ? 'user' : 'assistant'}`;
    div.innerHTML = escapeHtml(msg.content || '').replace(/\n/g, '<br>');
    chatMessagesEl.appendChild(div);
  }
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

function setChatSessions(sessions) {
  state.chatSessions = Array.isArray(sessions) ? sessions : [];
  chatSessionListEl.innerHTML = '';
  for (const session of state.chatSessions) {
    const button = document.createElement('button');
    button.className = `session-item ${session.conversationId === state.currentConversationId ? 'active' : ''}`;
    button.type = 'button';
    button.dataset.conversationId = session.conversationId || '';
    const rawTitle = String(session.title || '').trim();
    const preview = session.latestMessage?.content || 'No messages yet';
    const showRawTitle = rawTitle && !isConversationIdLike(rawTitle, session.conversationId);
    const sourceText = showRawTitle ? rawTitle : preview;
    const fallbackTag = summarizeWords(sourceText, 3, 3) || 'New Thread Here';
    const sessionTag = summarizeWords(session.sessionLabel || fallbackTag, 3, 3) || fallbackTag;
    const longDescription = summarize(
      session.sessionDescription || (showRawTitle ? `${rawTitle}. ${preview}` : preview) || 'No details yet.',
      220
    );
    button.innerHTML = `
      <div class="session-title">
        <span class="session-chip">${escapeHtml(sessionTag)}</span>
        <span class="session-hover-desc">${escapeHtml(longDescription)}</span>
      </div>
    `;
    button.addEventListener('click', async () => {
      if (!session.conversationId) return;
      state.currentConversationId = String(session.conversationId);
      localStorage.setItem('webUxConversationId', state.currentConversationId);
      await loadConversationMessages(state.currentConversationId);
      setChatSessions(state.chatSessions);
    });
    chatSessionListEl.appendChild(button);
  }
}

async function loadChatSessions() {
  ensureSignedIn();
  const data = await apiGet('/api/chat/sessions?limit=25');
  const sessions = Array.isArray(data.sessions) ? data.sessions : [];
  setChatSessions(sessions);
  const cachedConversationId = localStorage.getItem('webUxConversationId');
  if (cachedConversationId && sessions.some((s) => s.conversationId === cachedConversationId)) {
    state.currentConversationId = cachedConversationId;
  } else if (!state.currentConversationId && sessions.length) {
    state.currentConversationId = String(sessions[0].conversationId || '');
  }
}

async function loadConversationMessages(conversationId) {
  if (!conversationId) {
    state.chatMessages = [];
    renderChatMessages();
    return;
  }
  const data = await apiGet(`/api/chat/sessions/${encodeURIComponent(conversationId)}/messages?limit=200`);
  state.chatMessages = Array.isArray(data.messages)
    ? data.messages.filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    : [];
  renderChatMessages();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function promptForRequiredProfileField(fieldName) {
  if (fieldName === 'displayName') {
    return window.prompt('Before we continue, what is your preferred display name?');
  }
  return window.prompt(`Before we continue, please provide: ${fieldName}`);
}

async function ensureProfileFromGateResponse(gateResponse) {
  const missingRequired = asArray(gateResponse?.missingRequired);
  if (!missingRequired.length) return true;
  const patch = {};
  for (const field of missingRequired) {
    const answer = promptForRequiredProfileField(field);
    const normalized = answer == null ? '' : String(answer).trim();
    if (!normalized) return false;
    patch[field] = normalized;
  }

  const missingOptional = new Set(asArray(gateResponse?.missingOptional));
  const addRoleAndOrg = missingOptional.has('role') || missingOptional.has('organization');
  if (addRoleAndOrg) {
    const role = window.prompt('Optional: what is your role? (Leave blank to skip)');
    if (role != null && String(role).trim()) patch.role = String(role).trim();
    const organization = window.prompt('Optional: what organization are you with? (Leave blank to skip)');
    if (organization != null && String(organization).trim()) patch.organization = String(organization).trim();
  }

  await apiPost('/api/memory/profile', {
    source: 'user_input',
    patch
  });
  return true;
}

async function sendChatMessage(overrideText) {
  const expectVoiceTts = state.voiceTurnExpectTts;
  state.voiceTurnExpectTts = false;
  const outgoing = parseOutgoingChatText(
    (
    overrideText !== undefined && overrideText !== null
      ? String(overrideText)
      : String(chatInputEl.value || '')
    ),
    { expectVoiceTts }
  );
  const text = outgoing.text;
  if (!text) return;
  ensureSignedIn();
  if (!state.currentConversationId) {
    state.currentConversationId = makeId('conv');
    localStorage.setItem('webUxConversationId', state.currentConversationId);
  }

  chatInputEl.value = '';
  state.chatMessages.push({ role: 'user', content: text });
  renderChatMessages();
  setStatus('Sending...');
  chatSendBtnEl.disabled = true;

  try {
    const payload = {
      messages: state.chatMessages,
      conversationId: state.currentConversationId,
      responseMode: outgoing.responseMode
    };
    let out = await apiPost('/api/chat', payload);
    if (out && out.needsProfile) {
      const okToContinue = await ensureProfileFromGateResponse(out);
      if (!okToContinue) {
        state.chatMessages.push({ role: 'assistant', content: 'Profile setup is required before I can continue.' });
        renderChatMessages();
        setStatus('Profile setup canceled');
        return;
      }
      out = await apiPost('/api/chat', payload);
    }
    if (out.conversationId) {
      state.currentConversationId = String(out.conversationId);
      localStorage.setItem('webUxConversationId', state.currentConversationId);
    }
    if (out.reply != null && String(out.reply).trim()) {
      state.chatMessages.push({ role: 'assistant', content: String(out.reply) });
      renderChatMessages();
    }
    await loadChatSessions();
    setStatus('');
    if (
      expectVoiceTts &&
      out &&
      out.reply != null &&
      String(out.reply).trim() &&
      !/^Error:\s/i.test(String(out.reply).trim())
    ) {
      try {
        await playAssistantTts(String(out.reply).trim(), {
          responseMode: outgoing.responseMode,
          rewriteForSpeech: true
        });
      } catch (playErr) {
        setStatus(`Voice playback: ${playErr.message || playErr}`);
      }
    }
  } catch (err) {
    state.chatMessages.push({ role: 'assistant', content: `Error: ${err.message || String(err)}` });
    renderChatMessages();
    setStatus('Failed to send message');
  } finally {
    chatSendBtnEl.disabled = false;
  }
}

async function onCardsClick(event) {
  const taskDeleteBtn = event.target && event.target.closest ? event.target.closest('.task-delete-btn') : null;
  if (taskDeleteBtn) {
    if (state.currentView !== 'tasks') return;
    const taskId = String(taskDeleteBtn.getAttribute('data-task-id') || '').trim();
    const taskListId = String(taskDeleteBtn.getAttribute('data-task-list-id') || '').trim();
    if (!taskId || !taskListId) return;
    const taskName = String(taskDeleteBtn.getAttribute('data-task-name') || '').trim() || 'this task';
    const confirmed = window.confirm(`Delete ${taskName}? This cannot be undone.`);
    if (!confirmed) return;
    const previousDisabled = !!taskDeleteBtn.disabled;
    taskDeleteBtn.disabled = true;
    try {
      await apiDelete(`/api/tasks/${encodeURIComponent(taskListId)}/${encodeURIComponent(taskId)}`);
      await renderTasks();
    } catch (err) {
      window.alert(`Unable to delete task: ${err.message || String(err)}`);
    } finally {
      taskDeleteBtn.disabled = previousDisabled;
    }
    return;
  }

  const deleteBtn = event.target && event.target.closest ? event.target.closest('.contact-delete-btn') : null;
  if (!deleteBtn) return;
  if (state.currentView !== 'contacts') return;
  const contactId = String(deleteBtn.getAttribute('data-contact-id') || '').trim();
  if (!contactId) return;
  const contactName = String(deleteBtn.getAttribute('data-contact-name') || '').trim() || 'this contact';
  const confirmed = window.confirm(`Delete ${contactName}? This cannot be undone.`);
  if (!confirmed) return;
  const previousDisabled = !!deleteBtn.disabled;
  deleteBtn.disabled = true;
  try {
    await apiDelete(`/api/contacts/${encodeURIComponent(contactId)}`);
    await renderContacts();
  } catch (err) {
    window.alert(`Unable to delete contact: ${err.message || String(err)}`);
  } finally {
    deleteBtn.disabled = previousDisabled;
  }
}

function newChat() {
  state.currentConversationId = makeId('conv');
  localStorage.setItem('webUxConversationId', state.currentConversationId);
  state.chatMessages = [];
  renderChatMessages();
  setChatSessions(state.chatSessions);
  setStatus('New chat started');
}

function onCardsFilterChange(event) {
  const cb = event.target;
  if (!cb || !cb.classList) return;
  if (cb.classList.contains('workload-account-filter-cb')) {
    if (state.currentView !== 'workloads') return;
    const viewRoot = cardsContainerEl.querySelector('.workloads-view');
    if (!viewRoot) return;
    const idx = cb.getAttribute('data-workload-filter-idx');
    if (idx == null) return;
    const col = viewRoot.querySelector(`section.workload-account-column[data-workload-filter-idx="${idx}"]`);
    if (col) col.classList.toggle('workload-account-column--filtered-out', !cb.checked);
    return;
  }
  if (cb.classList.contains('task-list-filter-cb')) {
    if (state.currentView !== 'tasks') return;
    const viewRoot = cardsContainerEl.querySelector('.tasks-view');
    if (!viewRoot) return;
    const listId = String(cb.getAttribute('data-task-list-filter-id') || '').trim();
    if (!listId) return;
    setTaskListVisibility(listId, !!cb.checked);
    const col = viewRoot.querySelector(`section.task-list-column[data-task-list-filter-id="${escapeCssAttrValue(listId)}"]`);
    if (col) col.classList.toggle('task-list-column--filtered-out', !cb.checked);
    return;
  }
  if (cb.classList.contains('contact-account-filter-cb')) {
    if (state.currentView !== 'contacts') return;
    const viewRoot = cardsContainerEl.querySelector('.contacts-view');
    if (!viewRoot) return;
    const key = String(cb.getAttribute('data-contact-filter-key') || '');
    if (!key) return;
    if (cb.checked) contactsViewState.selectedAccounts.add(key);
    else contactsViewState.selectedAccounts.delete(key);
    viewRoot.querySelectorAll('.contact-account-section').forEach((section) => {
      if (String(section.getAttribute('data-contact-filter-key') || '') !== key) return;
      section.classList.toggle('contact-account-section--filtered-out', !cb.checked);
    });
    return;
  }
  if (cb.classList.contains('contacts-view-mode-cb')) {
    if (state.currentView !== 'contacts' || !cb.checked) return;
    const viewRoot = cardsContainerEl.querySelector('.contacts-view');
    if (!viewRoot) return;
    contactsViewState.mode = cb.value === 'table' ? 'table' : 'hierarchy';
    applyContactsViewState(viewRoot);
    return;
  }
  if (cb.classList.contains('contact-table-column-cb')) {
    if (state.currentView !== 'contacts') return;
    const viewRoot = cardsContainerEl.querySelector('.contacts-view');
    if (!viewRoot) return;
    const key = String(cb.getAttribute('data-contact-column-key') || '').trim();
    if (!key) return;
    const selectedCount = viewRoot.querySelectorAll('.contact-table-column-cb:checked').length;
    if (!cb.checked && selectedCount === 0) {
      cb.checked = true;
      return;
    }
    if (cb.checked) contactsViewState.selectedColumns.add(key);
    else contactsViewState.selectedColumns.delete(key);
    viewRoot.querySelectorAll('.contact-table-column').forEach((cell) => {
      if (String(cell.getAttribute('data-contact-column-key') || '') !== key) return;
      cell.classList.toggle('contact-table-column--hidden', !cb.checked);
    });
  }
}

navIconsEl.addEventListener('click', async (event) => {
  const button = event.target.closest('.icon-btn');
  if (!button) return;
  const nextView = button.dataset.view || 'home';

  if (isMobileLayout() && nextView === 'chat') {
    setMobileChatOpen(true);
    return;
  }
  if (isMobileLayout()) {
    setMobileChatOpen(false);
  }
  await renderView(nextView);
});

cardsContainerEl.addEventListener('change', onCardsFilterChange);
cardsContainerEl.addEventListener('click', (event) => {
  onCardsClick(event);
});

chatSendBtnEl.addEventListener('click', sendChatMessage);
chatInputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') sendChatMessage();
});
newChatBtnEl.addEventListener('click', newChat);
if (signOutBtnEl) {
  signOutBtnEl.addEventListener('click', () => {
    clearAuthState();
    state.currentConversationId = null;
    state.chatMessages = [];
    state.chatSessions = [];
    renderChatMessages();
    setChatSessions([]);
    window.location.replace('/login');
  });
}

window.addEventListener('keydown', onVoiceKeyDown, true);
window.addEventListener('keyup', onVoiceKeyUp, true);
window.addEventListener('blur', () => {
  if (!voiceShortcutHeld && !voicePttRecording && !voiceMicPointerHeld) return;
  voiceShortcutHeld = false;
  voiceMicPointerHeld = false;
  if (!voicePttRecording) {
    voiceCancelStart = true;
    return;
  }
  stopVoiceCaptureAndSend();
});

MOBILE_MQ.addEventListener('change', async () => {
  updateChatInputPlaceholder();
  if (!isMobileLayout()) {
    setMobileChatOpen(false);
    if (!state.currentView || state.currentView === 'chat') {
      await renderView('home');
    }
  } else {
    setMobileChatOpen(true);
  }
});

function hasPendingOAuthRedirectHash() {
  const hash = window.location.hash?.startsWith('#') ? window.location.hash.slice(1) : '';
  if (!hash) return false;
  const params = new URLSearchParams(hash);
  return params.has('id_token') || params.has('error');
}

(async function init() {
  try {
    loadStoredAuthState();
    if (!isAuthenticated() && !hasPendingOAuthRedirectHash()) {
      window.location.replace('/login');
      return;
    }
    updateAuthUi();
    loadTaskListFilterState();
    setupChatMicBtn();
    updateChatInputPlaceholder();
    if (isMobileLayout()) {
      setMobileChatOpen(true);
    } else {
      await renderView('home');
    }
    await loadChatSessions();
    if (state.currentConversationId) {
      await loadConversationMessages(state.currentConversationId);
    } else {
      renderChatMessages();
    }
  } catch (err) {
    setCardsFromHtml(cardHtml('Initialization Error', escapeHtml(err.message || String(err)), 'Check NODE_API_BASE_URL'));
    setStatus('Unable to load chat');
  }
})();
