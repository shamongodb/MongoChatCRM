import 'dotenv/config';
import { MongoClient } from 'mongodb';

const {
  MONGO_URI = '',
  MONGO_DB_NAME = 'sales_data',
  MONGO_AUTH_USERS_COLLECTION = 'auth_users',
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
const defaultEmail = 'shaun.banta@mongodb.com';
const lookupEmail = String(process.env.CRM_BACKFILL_OWNER_EMAIL || defaultEmail).trim().toLowerCase();
const fallbackUserId = String(process.env.CRM_BACKFILL_OWNER_USER_ID || '').trim() || null;

const collectionNames = [
  MONGO_TASK_LISTS_COLLECTION,
  MONGO_TASKS_COLLECTION,
  MONGO_CONTACTS_COLLECTION,
  MONGO_ACCOUNTS_COLLECTION,
  MONGO_WORKLOADS_COLLECTION,
  MONGO_MILESTONES_COLLECTION,
  MONGO_INITIATIVES_COLLECTION
].map((name) => String(name || '').trim()).filter(Boolean);

async function resolveOwnerUserId(db) {
  const authUsers = db.collection(MONGO_AUTH_USERS_COLLECTION);
  const row = await authUsers.findOne(
    { email: lookupEmail },
    { projection: { userId: 1, email: 1 } }
  );
  const userId = row?.userId ? String(row.userId).trim() : '';
  if (userId) return userId;
  if (fallbackUserId) return fallbackUserId;
  throw new Error(
    `Unable to resolve owner userId from ${MONGO_AUTH_USERS_COLLECTION} for email "${lookupEmail}". ` +
    'Set CRM_BACKFILL_OWNER_USER_ID to run this script.'
  );
}

async function run() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  try {
    const db = client.db(MONGO_DB_NAME);
    const ownerUserId = await resolveOwnerUserId(db);
    console.log(`Resolved owner userId: ${ownerUserId}`);

    let totalScanned = 0;
    let totalRowsToUpdate = 0;
    let totalMissingOwner = 0;
    let totalMissingCreatedBy = 0;
    let totalMissingUpdatedBy = 0;

    for (const collectionName of collectionNames) {
      const collection = db.collection(collectionName);
      const rows = await collection.find(
        {},
        { projection: { ownerUserId: 1, createdBy: 1, updatedBy: 1 } }
      ).toArray();
      let scanned = 0;
      let missingOwner = 0;
      let missingCreatedBy = 0;
      let missingUpdatedBy = 0;
      let rowsToUpdate = 0;

      for (const row of rows) {
        scanned += 1;
        const set = {};
        const rowOwnerUserId = row?.ownerUserId ? String(row.ownerUserId).trim() : '';
        const rowCreatedBy = row?.createdBy ? String(row.createdBy).trim() : '';
        const rowUpdatedBy = row?.updatedBy ? String(row.updatedBy).trim() : '';
        if (!rowOwnerUserId) {
          set.ownerUserId = ownerUserId;
          missingOwner += 1;
        }
        if (!rowCreatedBy || rowCreatedBy.toLowerCase() === 'system') {
          set.createdBy = ownerUserId;
          missingCreatedBy += 1;
        }
        if (!rowUpdatedBy || rowUpdatedBy.toLowerCase() === 'system') {
          set.updatedBy = ownerUserId;
          missingUpdatedBy += 1;
        }
        if (!Object.keys(set).length) continue;
        if (execute) {
          await collection.updateOne({ _id: row._id }, { $set: set });
        }
        rowsToUpdate += 1;
      }

      totalScanned += scanned;
      totalRowsToUpdate += rowsToUpdate;
      totalMissingOwner += missingOwner;
      totalMissingCreatedBy += missingCreatedBy;
      totalMissingUpdatedBy += missingUpdatedBy;
      console.log(
        `[${collectionName}] scanned=${scanned} missingOwner=${missingOwner} ` +
        `missingCreatedBy=${missingCreatedBy} missingUpdatedBy=${missingUpdatedBy} rowsToUpdate=${rowsToUpdate}`
      );
    }

    console.log(`Total scanned: ${totalScanned}`);
    console.log(`Rows missing ownerUserId: ${totalMissingOwner}`);
    console.log(`Rows missing createdBy/system: ${totalMissingCreatedBy}`);
    console.log(`Rows missing updatedBy/system: ${totalMissingUpdatedBy}`);
    console.log(`Total rows ${execute ? 'updated' : 'that would be updated'}: ${totalRowsToUpdate}`);
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
