import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient, ObjectId } from 'mongodb';
import { closeMongoClientConnection, runMongoTool } from '../src/index.js';

const mongoUri = String(process.env.MONGO_URI || '').trim();
const mongoDbName = String(process.env.MONGO_DB_NAME || 'sales_data').trim();
const accountsCollectionName = String(process.env.MONGO_ACCOUNTS_COLLECTION || 'accounts').trim();
const workloadsCollectionName = String(process.env.MONGO_WORKLOADS_COLLECTION || 'Workloads').trim();
const milestonesCollectionName = String(process.env.MONGO_MILESTONES_COLLECTION || 'milestones').trim();

if (!mongoUri) {
  test('milestone tests skipped without mongo', { skip: true }, () => {});
} else {
  after(async () => {
    await closeMongoClientConnection();
  });

  async function connectOrSkip(t) {
    const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 2000 });
    try {
      await client.connect();
      return client;
    } catch (err) {
      t.skip(`Mongo unavailable for integration test: ${err?.message || err}`);
      return null;
    }
  }

  test('addMilestone validates required fields', async (t) => {
    const client = await connectOrSkip(t);
    if (!client) return;
    try {
      const missingName = await runMongoTool('addMilestone', {
        milestoneDate: '2026-05-12'
      });
      assert.match(String(missingName.error || ''), /name is required/i);

      const missingDate = await runMongoTool('addMilestone', {
        name: 'Launch prep'
      });
      assert.match(String(missingDate.error || ''), /milestoneDate/i);
    } finally {
      await client.close();
    }
  });

  test('addMilestone defaults month date, status, and narr from workload arr', async (t) => {
    const client = await connectOrSkip(t);
    if (!client) return;
    const db = client.db(mongoDbName);
    const accounts = db.collection(accountsCollectionName);
    const workloads = db.collection(workloadsCollectionName);
    const milestones = db.collection(milestonesCollectionName);
    const runId = `milestone-create-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const nowIso = new Date().toISOString();
    const accountId = new ObjectId();
    const workloadId = new ObjectId();
    let createdMilestoneId = null;
    try {
      await accounts.insertOne({
        _id: accountId,
        name: `Account ${runId}`,
        createdAt: nowIso,
        updatedAt: nowIso
      });
      await workloads.insertOne({
        _id: workloadId,
        name: `Workload ${runId}`,
        accountId: String(accountId),
        accountName: `Account ${runId}`,
        arr: 175000,
        contactIds: [],
        contacts: [],
        createdAt: nowIso,
        updatedAt: nowIso
      });
      const out = await runMongoTool('addMilestone', {
        name: `Milestone ${runId}`,
        milestoneDate: '2026-02',
        accountId: String(accountId),
        workloadIds: [String(workloadId)]
      });
      assert.equal(out.ok, true);
      assert.equal(out.milestone.milestoneDate, '2026-02-28');
      assert.equal(out.milestone.status, 'On Target');
      assert.equal(out.milestone.narr, 175000);
      createdMilestoneId = String(out.milestoneId);
    } finally {
      if (createdMilestoneId) await milestones.deleteOne({ _id: new ObjectId(createdMilestoneId) });
      await workloads.deleteMany({ _id: { $in: [workloadId] } });
      await accounts.deleteMany({ _id: { $in: [accountId] } });
      await client.close();
    }
  });

  test('updateMilestone supports notes lifecycle and listMilestones date/status filters', async (t) => {
    const client = await connectOrSkip(t);
    if (!client) return;
    const db = client.db(mongoDbName);
    const milestones = db.collection(milestonesCollectionName);
    const runId = `milestone-update-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    let m1Id = null;
    let m2Id = null;
    try {
      const created = await runMongoTool('addMilestone', {
        name: `Delayed ${runId}`,
        milestoneDate: '2026-03-15',
        status: 'Delayed'
      });
      assert.equal(created.ok, true);
      m1Id = String(created.milestoneId);

      const withNote = await runMongoTool('updateMilestone', {
        milestoneId: m1Id,
        addNote: { text: 'Initial dependency risk', author: 'QA' }
      });
      assert.equal(withNote.ok, true);
      assert.equal(Array.isArray(withNote.milestone.notes), true);
      assert.equal(withNote.milestone.notes.length, 1);

      const noteId = String(withNote.milestone.notes[0].id);
      const edited = await runMongoTool('updateMilestone', {
        milestoneId: m1Id,
        editNote: { id: noteId, text: 'Risk mitigated', author: 'QA' }
      });
      assert.equal(edited.ok, true);
      assert.equal(edited.milestone.notes[0].text, 'Risk mitigated');

      const removed = await runMongoTool('updateMilestone', {
        milestoneId: m1Id,
        removeNoteId: noteId
      });
      assert.equal(removed.ok, true);
      assert.equal(removed.milestone.notes.length, 0);

      const createdSecond = await runMongoTool('addMilestone', {
        name: `Completed ${runId}`,
        milestoneDate: '2026-05-20',
        status: 'Completed'
      });
      assert.equal(createdSecond.ok, true);
      m2Id = String(createdSecond.milestoneId);

      const filtered = await runMongoTool('listMilestones', {
        status: 'Delayed',
        from: '2026-03',
        to: '2026-04'
      });
      assert.equal(Array.isArray(filtered.milestones), true);
      assert.equal(filtered.milestones.length, 1);
      assert.equal(filtered.milestones[0].status, 'Delayed');
      assert.equal(filtered.milestones[0].milestoneDate, '2026-03-15');
    } finally {
      if (m1Id) await milestones.deleteOne({ _id: new ObjectId(m1Id) });
      if (m2Id) await milestones.deleteOne({ _id: new ObjectId(m2Id) });
      await client.close();
    }
  });
}
