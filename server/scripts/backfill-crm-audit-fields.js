import 'dotenv/config';
import { MongoClient } from 'mongodb';

const {
  MONGO_URI = '',
  MONGO_DB_NAME = 'sales_data',
  MONGO_TASK_LISTS_COLLECTION = 'taskLists',
  MONGO_TASKS_COLLECTION = 'tasks',
  MONGO_CONTACTS_COLLECTION = 'contacts',
  MONGO_ACCOUNTS_COLLECTION = 'accounts',
  MONGO_WORKLOADS_COLLECTION = 'Workloads',
  MONGO_MILESTONES_COLLECTION = 'milestones',
  MONGO_INITIATIVES_COLLECTION = 'initiatives'
} = process.env;

if (!MONGO_URI) {
  console.error('MONGO_URI is required');
  process.exit(1);
}

const execute = process.argv.includes('--execute');
const actor = String(process.env.AUDIT_BACKFILL_ACTOR || 'system').trim() || 'system';

const collectionNames = [
  MONGO_TASK_LISTS_COLLECTION,
  MONGO_TASKS_COLLECTION,
  MONGO_CONTACTS_COLLECTION,
  MONGO_ACCOUNTS_COLLECTION,
  MONGO_WORKLOADS_COLLECTION,
  MONGO_MILESTONES_COLLECTION,
  MONGO_INITIATIVES_COLLECTION
].map((name) => String(name || '').trim()).filter(Boolean);

async function run() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  try {
    const db = client.db(MONGO_DB_NAME);
    let totalScanned = 0;
    let totalNeedsCreatedBy = 0;
    let totalNeedsUpdatedBy = 0;
    let totalUpdated = 0;

    for (const collectionName of collectionNames) {
      const collection = db.collection(collectionName);
      const rows = await collection.find({}, { projection: { createdBy: 1, updatedBy: 1 } }).toArray();
      let scanned = 0;
      let needsCreatedBy = 0;
      let needsUpdatedBy = 0;
      let updated = 0;
      for (const row of rows) {
        scanned += 1;
        const set = {};
        if (!row?.createdBy || !String(row.createdBy).trim()) {
          set.createdBy = actor;
          needsCreatedBy += 1;
        }
        if (!row?.updatedBy || !String(row.updatedBy).trim()) {
          set.updatedBy = actor;
          needsUpdatedBy += 1;
        }
        if (!Object.keys(set).length) continue;
        if (execute) {
          await collection.updateOne({ _id: row._id }, { $set: set });
        }
        updated += 1;
      }
      totalScanned += scanned;
      totalNeedsCreatedBy += needsCreatedBy;
      totalNeedsUpdatedBy += needsUpdatedBy;
      totalUpdated += updated;
      console.log(`[${collectionName}] scanned=${scanned} createdByMissing=${needsCreatedBy} updatedByMissing=${needsUpdatedBy} rowsToUpdate=${updated}`);
    }

    console.log(`Total scanned: ${totalScanned}`);
    console.log(`Rows needing createdBy: ${totalNeedsCreatedBy}`);
    console.log(`Rows needing updatedBy: ${totalNeedsUpdatedBy}`);
    console.log(`Total rows ${execute ? 'updated' : 'that would be updated'}: ${totalUpdated}`);
    if (!execute) {
      console.log('Dry run complete. Re-run with --execute to apply updates.');
    }
  } finally {
    await client.close();
  }
}

run().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
