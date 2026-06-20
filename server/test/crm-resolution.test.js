import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient, ObjectId } from 'mongodb';
import { closeMongoClientConnection, runMongoTool } from '../src/index.js';

const mongoUri = String(process.env.MONGO_URI || '').trim();
const mongoDbName = String(process.env.MONGO_DB_NAME || 'sales_data').trim();
const accountsCollectionName = String(process.env.MONGO_ACCOUNTS_COLLECTION || 'accounts').trim();
const contactsCollectionName = String(process.env.MONGO_CONTACTS_COLLECTION || 'contacts').trim();
const workloadsCollectionName = String(process.env.MONGO_WORKLOADS_COLLECTION || 'Workloads').trim();
const TEST_USER_ID = 'google_test_crm_resolution';

function runCrmTool(name, args) {
  return runMongoTool(name, args, { userId: TEST_USER_ID, initiatedByUserId: TEST_USER_ID });
}

if (!mongoUri) {
  test('crm resolution tests skipped without mongo', { skip: true }, () => {});
} else {
  after(async () => {
    await closeMongoClientConnection();
  });

  test('updateWorkload resolves by scoped account and preserves contacts on account-only update', async (t) => {
    const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 2000 });
    try {
      await client.connect();
    } catch (err) {
      t.skip(`Mongo unavailable for integration test: ${err?.message || err}`);
      return;
    }
    const db = client.db(mongoDbName);
    const accounts = db.collection(accountsCollectionName);
    const contacts = db.collection(contactsCollectionName);
    const workloads = db.collection(workloadsCollectionName);
    const runId = `crm-resolution-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const nowIso = new Date().toISOString();

    const accountAId = new ObjectId();
    const accountBId = new ObjectId();
    const contactId = new ObjectId();
    const workloadAId = new ObjectId();
    const workloadBId = new ObjectId();
    const scopedName = `PS - GLM Migration ${runId}`;

    try {
      await accounts.insertMany([
        { _id: accountAId, name: `Lumen A ${runId}`, ownerUserId: TEST_USER_ID, createdAt: nowIso, updatedAt: nowIso },
        { _id: accountBId, name: `Lumen B ${runId}`, ownerUserId: TEST_USER_ID, createdAt: nowIso, updatedAt: nowIso }
      ]);
      await contacts.insertOne({
        _id: contactId,
        name: `Beth Gunn ${runId}`,
        ownerUserId: TEST_USER_ID,
        accountId: String(accountAId),
        accountName: `Lumen A ${runId}`,
        notes: [],
        workloadIds: [],
        createdAt: nowIso,
        updatedAt: nowIso
      });
      await workloads.insertMany([
        {
          _id: workloadAId,
          name: scopedName,
          ownerUserId: TEST_USER_ID,
          accountId: String(accountAId),
          accountName: `Lumen A ${runId}`,
          contactIds: [String(contactId)],
          contacts: [{ contactId: String(contactId), name: `Beth Gunn ${runId}`, email: null, title: null }],
          createdAt: nowIso,
          updatedAt: nowIso
        },
        {
          _id: workloadBId,
          name: scopedName,
          ownerUserId: TEST_USER_ID,
          accountId: String(accountBId),
          accountName: `Lumen B ${runId}`,
          contactIds: [],
          contacts: [],
          createdAt: nowIso,
          updatedAt: nowIso
        }
      ]);

      const scopedUpdate = await runCrmTool('updateWorkload', {
        workloadName: scopedName,
        accountId: String(accountAId),
        notes: `updated ${runId}`
      });
      assert.equal(scopedUpdate.ok, true);
      assert.equal(String(scopedUpdate.workload._id), String(workloadAId));
      assert.equal(scopedUpdate.workload.accountId, String(accountAId));
      assert.deepEqual(scopedUpdate.workload.contactIds, [String(contactId)]);
    } finally {
      await workloads.deleteMany({
        _id: { $in: [workloadAId, workloadBId] }
      });
      await contacts.deleteMany({ _id: { $in: [contactId] } });
      await accounts.deleteMany({ _id: { $in: [accountAId, accountBId] } });
      await client.close();
    }
  });

  test('addWorkload applies partial success for mixed contactIds', async (t) => {
    const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 2000 });
    try {
      await client.connect();
    } catch (err) {
      t.skip(`Mongo unavailable for integration test: ${err?.message || err}`);
      return;
    }
    const db = client.db(mongoDbName);
    const accounts = db.collection(accountsCollectionName);
    const contacts = db.collection(contactsCollectionName);
    const workloads = db.collection(workloadsCollectionName);
    const runId = `crm-partial-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const nowIso = new Date().toISOString();

    const accountId = new ObjectId();
    const contactId = new ObjectId();
    const invalidContactId = 'not-a-valid-contact-id';

    let insertedWorkloadId = null;
    try {
      await accounts.insertOne({
        _id: accountId,
        name: `Lumen ${runId}`,
        ownerUserId: TEST_USER_ID,
        createdAt: nowIso,
        updatedAt: nowIso
      });
      await contacts.insertOne({
        _id: contactId,
        name: `Sharon Modiz ${runId}`,
        ownerUserId: TEST_USER_ID,
        accountId: String(accountId),
        accountName: `Lumen ${runId}`,
        notes: [],
        workloadIds: [],
        createdAt: nowIso,
        updatedAt: nowIso
      });

      const result = await runCrmTool('addWorkload', {
        name: `PS - GLM Migration ${runId}`,
        accountId: String(accountId),
        contactIds: [String(contactId), invalidContactId],
        confirm: true
      });
      assert.equal(result.ok, true);
      assert.equal(Array.isArray(result.warnings), true);
      assert.equal(result.warnings.length, 1);
      assert.equal(result.warnings[0].reason, 'invalid_id');
      assert.deepEqual(result.workload.contactIds, [String(contactId)]);
      insertedWorkloadId = String(result.workloadId);
    } finally {
      if (insertedWorkloadId) {
        await workloads.deleteOne({ _id: new ObjectId(insertedWorkloadId) });
      }
      await contacts.deleteMany({ _id: { $in: [contactId] } });
      await accounts.deleteMany({ _id: { $in: [accountId] } });
      await client.close();
    }
  });

  test('deleteContact requires confirm and removes contact from workloads', async (t) => {
    const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 2000 });
    try {
      await client.connect();
    } catch (err) {
      t.skip(`Mongo unavailable for integration test: ${err?.message || err}`);
      return;
    }
    const db = client.db(mongoDbName);
    const accounts = db.collection(accountsCollectionName);
    const contacts = db.collection(contactsCollectionName);
    const workloads = db.collection(workloadsCollectionName);
    const runId = `crm-delete-contact-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const nowIso = new Date().toISOString();

    const accountId = new ObjectId();
    const contactId = new ObjectId();
    const workloadId = new ObjectId();
    const contactName = `Delete Me ${runId}`;

    try {
      await accounts.insertOne({
        _id: accountId,
        name: `Acme ${runId}`,
        ownerUserId: TEST_USER_ID,
        createdAt: nowIso,
        updatedAt: nowIso
      });
      await contacts.insertOne({
        _id: contactId,
        name: contactName,
        ownerUserId: TEST_USER_ID,
        accountId: String(accountId),
        accountName: `Acme ${runId}`,
        notes: [],
        workloadIds: [],
        createdAt: nowIso,
        updatedAt: nowIso
      });
      await workloads.insertOne({
        _id: workloadId,
        name: `WL ${runId}`,
        ownerUserId: TEST_USER_ID,
        accountId: String(accountId),
        accountName: `Acme ${runId}`,
        contactIds: [String(contactId)],
        contacts: [{ contactId: String(contactId), name: contactName, email: null, title: null }],
        createdAt: nowIso,
        updatedAt: nowIso
      });

      const withoutConfirm = await runCrmTool('deleteContact', {
        contactId: String(contactId),
        confirm: false
      });
      assert.ok(withoutConfirm.error);
      assert.match(withoutConfirm.error, /Confirmation required/i);

      const deleted = await runCrmTool('deleteContact', {
        contactId: String(contactId),
        confirm: true
      });
      assert.equal(deleted.ok, true);
      assert.equal(deleted.deleted, true);
      assert.equal(deleted.contactId, String(contactId));
      assert.equal(deleted.workloadsUpdated, 1);

      const contactAfter = await contacts.findOne({ _id: contactId });
      assert.equal(contactAfter, null);

      const workloadAfter = await workloads.findOne({ _id: workloadId });
      assert.deepEqual(workloadAfter.contactIds, []);
      assert.deepEqual(workloadAfter.contacts, []);
    } finally {
      await workloads.deleteMany({ _id: { $in: [workloadId] } });
      await contacts.deleteMany({ _id: { $in: [contactId] } });
      await accounts.deleteMany({ _id: { $in: [accountId] } });
      await client.close();
    }
  });
}
