import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { parseWorkloadStage } from '../src/workload-stage.js';

const {
  MONGO_URI = '',
  MONGO_DB_NAME = 'sales_data',
  MONGO_WORKLOADS_COLLECTION = 'Workloads'
} = process.env;

if (!MONGO_URI) {
  console.error('MONGO_URI is required');
  process.exit(1);
}

const overwrite = process.argv.includes('--overwrite');

function normalizeWebUrl(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.toString();
  } catch (_err) {
    return '';
  }
}

function parseLooseCurrencyValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value == null ? '' : value).trim();
  if (!text) return null;
  const normalized = text
    .replace(/[$,\s]/g, '')
    .replace(/usd/ig, '')
    .toLowerCase();
  const suffixMatch = normalized.match(/^(-?\d+(?:\.\d+)?)([km])$/i);
  if (suffixMatch) {
    const base = Number(suffixMatch[1]);
    if (!Number.isFinite(base)) return null;
    const mult = suffixMatch[2].toLowerCase() === 'm' ? 1000000 : 1000;
    return base * mult;
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function extractSalesforceUrlFromText(value) {
  const text = String(value || '');
  if (!text.trim()) return '';
  const explicitMatch = text.match(/(?:^|\n)\s*(?:Salesforce(?:\s+Link)?|SFDC(?:\s+Link)?)\s*:\s*(https?:\/\/\S+)/i);
  if (explicitMatch) {
    const explicitHref = normalizeWebUrl(explicitMatch[1]);
    if (explicitHref) return explicitHref;
  }
  const urlMatches = text.match(/https?:\/\/\S+/gi) || [];
  for (const raw of urlMatches) {
    const cleaned = raw.replace(/[),.;]+$/, '');
    const href = normalizeWebUrl(cleaned);
    if (!href) continue;
    if (/salesforce\.com|force\.com/i.test(href)) return href;
  }
  return '';
}

function extractLegacyWorkloadFields(doc) {
  const sourceTexts = [doc?.description, doc?.notes].map((value) => String(value || ''));
  const combined = sourceTexts.join('\n');
  const stageMatch = combined.match(/(?:^|\n)\s*Stage\s*:\s*([^\n\r]+)/i);
  const arrMatch = combined.match(/(?:^|\n)\s*ARR\s*:\s*([^\n\r]+)/i);
  const rawArr = arrMatch ? String(arrMatch[1] || '').trim() : '';
  const parsedArr = parseLooseCurrencyValue(rawArr);
  const rawStage = stageMatch ? String(stageMatch[1] || '').trim() : '';
  const parsedStage = parseWorkloadStage(rawStage, { defaultWhenMissing: false });
  return {
    stage: parsedStage.ok && parsedStage.stage ? parsedStage.stage : '',
    arr: parsedArr != null && parsedArr >= 0 ? Math.round(parsedArr) : null,
    salesforceLink: extractSalesforceUrlFromText(combined)
  };
}

function isEmpty(value) {
  if (value == null) return true;
  if (typeof value === 'string') return !value.trim();
  return false;
}

async function run() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  try {
    const collection = client.db(MONGO_DB_NAME).collection(MONGO_WORKLOADS_COLLECTION);
    const rows = await collection.find({}).toArray();
    let scanned = 0;
    let updated = 0;
    let arrBackfilled = 0;
    let stageBackfilled = 0;
    let salesforceBackfilled = 0;

    for (const row of rows) {
      scanned += 1;
      const legacy = extractLegacyWorkloadFields(row);
      const set = {};

      const shouldSetArr = overwrite ? legacy.arr != null : isEmpty(row.arr) && legacy.arr != null;
      if (shouldSetArr) {
        set.arr = legacy.arr;
        arrBackfilled += 1;
      }

      const shouldSetStage = overwrite ? !!legacy.stage : isEmpty(row.stage) && !!legacy.stage;
      if (shouldSetStage) {
        set.stage = legacy.stage;
        stageBackfilled += 1;
      }

      const shouldSetSalesforce = overwrite ? !!legacy.salesforceLink : isEmpty(row.salesforceLink) && !!legacy.salesforceLink;
      if (shouldSetSalesforce) {
        set.salesforceLink = legacy.salesforceLink;
        salesforceBackfilled += 1;
      }

      if (!Object.keys(set).length) continue;
      set.updatedAt = new Date().toISOString();
      await collection.updateOne({ _id: row._id }, { $set: set });
      updated += 1;
    }

    console.log(`Scanned ${scanned} workloads`);
    console.log(`Updated ${updated} workloads`);
    console.log(`Backfilled arr on ${arrBackfilled} workloads`);
    console.log(`Backfilled stage on ${stageBackfilled} workloads`);
    console.log(`Backfilled salesforceLink on ${salesforceBackfilled} workloads`);
    if (!overwrite) {
      console.log('Run with --overwrite to replace existing structured values from description/notes parsing.');
    }
  } finally {
    await client.close();
  }
}

run().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
