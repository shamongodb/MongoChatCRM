import { ChatPromptTemplate } from '@langchain/core/prompts';
import { RunnableSequence } from '@langchain/core/runnables';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { AzureChatOpenAI } from '@langchain/openai';
import {
  getSummaryState,
  getUnsummarizedMessages,
  saveConversationSummary
} from './store.js';

function buildTranscriptSnippet(rows) {
  return rows.map((row) => {
    const role = row.role || 'unknown';
    const content = row.content == null ? '' : String(row.content);
    return `${role.toUpperCase()}: ${content}`;
  }).join('\n');
}

async function retryWithBackoff(fn, retries = 2) {
  let attempt = 0;
  while (attempt <= retries) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === retries) throw err;
      const waitMs = (attempt + 1) * 750;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      attempt += 1;
    }
  }
  throw new Error('Retry loop exhausted');
}

function createSummaryChain(cfg) {
  const endpoint = cfg.azureOpenAIEndpoint || cfg.azureEndpoint;
  if (!cfg.langchainDeployment || !cfg.azureApiKey || !endpoint) {
    return null;
  }
  const prompt = ChatPromptTemplate.fromMessages([
    [
      'system',
      'You maintain durable conversation memory for an assistant. Merge new transcript lines into the existing summary. Keep concise, factual bullets, preserve user preferences, constraints, commitments, and unresolved tasks. Do not invent facts.'
    ],
    [
      'human',
      'Existing summary:\n{existingSummary}\n\nNew transcript lines:\n{transcript}\n\nReturn an updated summary only.'
    ]
  ]);
  const model = new AzureChatOpenAI({
    azureOpenAIApiKey: cfg.azureApiKey,
    azureOpenAIEndpoint: endpoint,
    azureOpenAIApiDeploymentName: cfg.langchainDeployment,
    azureOpenAIApiVersion: cfg.langchainApiVersion,
    temperature: 0
  });
  return RunnableSequence.from([prompt, model, new StringOutputParser()]);
}

export async function maybeRefreshConversationSummary(db, cfg, conversationId, force = false) {
  const summaryState = await getSummaryState(db, cfg, conversationId);
  const coveredUntil = summaryState?.coveredUntilMessageId || null;
  const pending = await getUnsummarizedMessages(db, cfg, conversationId, coveredUntil, cfg.summaryBatchSize);
  if (!pending.length) {
    return { refreshed: false, reason: 'no_new_messages', processed: 0 };
  }
  if (!force && pending.length < cfg.summaryThresholdMessages) {
    return { refreshed: false, reason: 'below_threshold', processed: 0 };
  }
  const chain = createSummaryChain(cfg);
  if (!chain) {
    return { refreshed: false, reason: 'langchain_not_configured', processed: 0 };
  }
  const transcript = buildTranscriptSnippet(pending);
  const existingSummary = summaryState?.summaryText || '';
  const summaryText = await retryWithBackoff(() => chain.invoke({ existingSummary, transcript }), cfg.summaryRetries);
  const lastId = String(pending[pending.length - 1]._id);
  await saveConversationSummary(db, cfg, conversationId, String(summaryText || '').trim(), lastId);
  return { refreshed: true, reason: 'updated', processed: pending.length, coveredUntilMessageId: lastId };
}

export async function rebuildConversationSummary(db, cfg, conversationId) {
  let refreshedAny = false;
  let totalProcessed = 0;
  while (true) {
    const result = await maybeRefreshConversationSummary(db, cfg, conversationId, true);
    if (!result.refreshed) break;
    refreshedAny = true;
    totalProcessed += result.processed || 0;
    if ((result.processed || 0) < cfg.summaryBatchSize) break;
  }
  return { refreshed: refreshedAny, processed: totalProcessed };
}
