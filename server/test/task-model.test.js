import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient, ObjectId } from 'mongodb';
import { closeMongoClientConnection, runMongoTool } from '../src/index.js';

const mongoUri = String(process.env.MONGO_URI || '').trim();
const mongoDbName = String(process.env.MONGO_DB_NAME || 'sales_data').trim();
const taskListsCollectionName = String(process.env.MONGO_TASK_LISTS_COLLECTION || 'taskLists').trim();
const tasksCollectionName = String(process.env.MONGO_TASKS_COLLECTION || 'tasks').trim();
const TEST_USER_ID = 'google_test_task_model';

function runCrmTool(name, args) {
  return runMongoTool(name, args, { userId: TEST_USER_ID, initiatedByUserId: TEST_USER_ID });
}

async function connectMongoOrSkip(t) {
  const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 2000 });
  try {
    await client.connect();
    return client;
  } catch (err) {
    t.skip(`Mongo unavailable for integration test: ${err?.message || err}`);
    return null;
  }
}

if (!mongoUri) {
  test('task model tests skipped without mongo', { skip: true }, () => {});
} else {
  after(async () => {
    await closeMongoClientConnection();
  });

  test('addTaskToList resolves a list by taskListName after createTaskList', async (t) => {
    const client = await connectMongoOrSkip(t);
    if (!client) return;
    const db = client.db(mongoDbName);
    const taskLists = db.collection(taskListsCollectionName);
    const tasks = db.collection(tasksCollectionName);
    const runId = `task-name-resolve-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const listName = `Voice List ${runId}`;

    let taskListId = null;
    try {
      const created = await runCrmTool('createTaskList', { name: listName });
      assert.equal(created.ok, true);
      taskListId = String(created.taskListId);

      const added = await runCrmTool('addTaskToList', {
        taskListName: listName,
        task: `Follow up ${runId}`
      });
      assert.equal(added.ok, true);
      assert.equal(added.task.taskListId, taskListId);

      const addedByNameInIdField = await runCrmTool('addTaskToList', {
        taskListId: listName,
        task: `Second item ${runId}`
      });
      assert.equal(addedByNameInIdField.ok, true);
      assert.equal(addedByNameInIdField.task.taskListId, taskListId);
    } finally {
      if (taskListId) {
        await tasks.deleteMany({ taskListId });
        await taskLists.deleteOne({ _id: new ObjectId(taskListId) });
      }
      await client.close();
    }
  });

  test('addTaskToList writes standalone task docs and getTaskList returns them', async (t) => {
    const client = await connectMongoOrSkip(t);
    if (!client) return;
    const db = client.db(mongoDbName);
    const taskLists = db.collection(taskListsCollectionName);
    const tasks = db.collection(tasksCollectionName);
    const runId = `task-model-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

    let taskListId = null;
    try {
      const created = await runCrmTool('createTaskList', { name: `Ops ${runId}`, owner: `Owner ${runId}` });
      assert.equal(created.ok, true);
      taskListId = String(created.taskListId);

      const added = await runCrmTool('addTaskToList', {
        taskListId,
        task: `Review migration ${runId}`,
        status: 'open',
        priority: 'Priority 2'
      });
      assert.equal(added.ok, true);
      assert.equal(added.task.taskListId, taskListId);
      assert.ok(added.task.taskId);

      const taskDoc = await tasks.findOne({ taskListId, taskId: String(added.task.taskId) });
      assert.ok(taskDoc);
      assert.equal(String(taskDoc.task), `Review migration ${runId}`);

      const fetched = await runCrmTool('getTaskList', { taskListId });
      assert.equal(String(fetched._id), taskListId);
      assert.equal(Array.isArray(fetched.tasks), true);
      assert.equal(fetched.tasks.some((row) => String(row.taskId) === String(added.task.taskId)), true);
    } finally {
      if (taskListId) {
        await tasks.deleteMany({ taskListId });
        await taskLists.deleteOne({ _id: new ObjectId(taskListId) });
      }
      await client.close();
    }
  });

  test('updateTaskInList keeps disambiguation and supports taskId updates', async (t) => {
    const client = await connectMongoOrSkip(t);
    if (!client) return;
    const db = client.db(mongoDbName);
    const tasks = db.collection(tasksCollectionName);
    const runId = `task-disambiguation-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

    let taskListId = null;
    try {
      const created = await runCrmTool('createTaskList', { name: `Disambiguation ${runId}` });
      assert.equal(created.ok, true);
      taskListId = String(created.taskListId);

      const first = await runCrmTool('addTaskToList', {
        taskListId,
        task: `Follow up with legal ${runId}`
      });
      const second = await runCrmTool('addTaskToList', {
        taskListId,
        task: `Follow up with finance ${runId}`
      });
      assert.equal(first.ok, true);
      assert.equal(second.ok, true);

      const ambiguous = await runCrmTool('updateTaskInList', {
        taskListId,
        taskText: 'follow up',
        status: 'done'
      });
      assert.equal(ambiguous.needsDisambiguation, true);
      assert.equal(Array.isArray(ambiguous.candidates), true);
      assert.ok(ambiguous.candidates.length >= 2);

      const updated = await runCrmTool('updateTaskInList', {
        taskListId,
        taskId: String(first.task.taskId),
        status: 'done'
      });
      assert.equal(updated.ok, true);
      assert.equal(updated.task.status, 'done');

      const persisted = await tasks.findOne({ taskListId, taskId: String(first.task.taskId) });
      assert.equal(String(persisted.status), 'done');
    } finally {
      if (taskListId) {
        await runCrmTool('deleteTaskList', { taskListId, confirm: true });
      }
      await client.close();
    }
  });

  test('updateTaskInList supports task-level owner without taskListId when taskId is provided', async (t) => {
    const client = await connectMongoOrSkip(t);
    if (!client) return;
    const db = client.db(mongoDbName);
    const tasks = db.collection(tasksCollectionName);
    const runId = `task-owner-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

    let taskListId = null;
    try {
      const created = await runCrmTool('createTaskList', { name: `Owner Scope ${runId}`, owner: `List Owner ${runId}` });
      assert.equal(created.ok, true);
      taskListId = String(created.taskListId);

      const added = await runCrmTool('addTaskToList', {
        taskListId,
        task: `Follow up with John ${runId}`
      });
      assert.equal(added.ok, true);
      assert.equal(added.task.owner, null);

      const updated = await runCrmTool('updateTaskInList', {
        taskId: String(added.task.taskId),
        owner: `Task Owner ${runId}`
      });
      assert.equal(updated.ok, true);
      assert.equal(updated.task.owner, `Task Owner ${runId}`);
      assert.equal(updated.task.taskListId, taskListId);

      const persisted = await tasks.findOne({ taskListId, taskId: String(added.task.taskId) });
      assert.equal(String(persisted.owner), `Task Owner ${runId}`);
    } finally {
      if (taskListId) {
        await runCrmTool('deleteTaskList', { taskListId, confirm: true });
      }
      await client.close();
    }
  });

  test('updateTaskList clears owner and syncs taskListName on rename', async (t) => {
    const client = await connectMongoOrSkip(t);
    if (!client) return;
    const db = client.db(mongoDbName);
    const tasks = db.collection(tasksCollectionName);
    const runId = `task-list-update-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

    let taskListId = null;
    try {
      const created = await runCrmTool('createTaskList', { name: `Eco ${runId}`, owner: `Benji ${runId}` });
      assert.equal(created.ok, true);
      taskListId = String(created.taskListId);

      const added = await runCrmTool('addTaskToList', { taskListId, task: `Item ${runId}` });
      assert.equal(added.ok, true);

      const cleared = await runCrmTool('updateTaskList', { taskListId, owner: '' });
      assert.equal(cleared.ok, true);
      assert.equal(cleared.taskList.owner, null);

      const renamed = await runCrmTool('updateTaskList', { taskListId, name: `Eco renamed ${runId}` });
      assert.equal(renamed.ok, true);
      const taskDoc = await tasks.findOne({ taskListId });
      assert.equal(String(taskDoc.taskListName), `Eco renamed ${runId}`);
    } finally {
      if (taskListId) {
        await runCrmTool('deleteTaskList', { taskListId, confirm: true });
      }
      await client.close();
    }
  });

  test('deleteTaskList removes linked task documents', async (t) => {
    const client = await connectMongoOrSkip(t);
    if (!client) return;
    const db = client.db(mongoDbName);
    const tasks = db.collection(tasksCollectionName);
    const runId = `task-delete-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

    let taskListId = null;
    try {
      const created = await runCrmTool('createTaskList', { name: `Delete ${runId}` });
      assert.equal(created.ok, true);
      taskListId = String(created.taskListId);

      await runCrmTool('addTaskToList', { taskListId, task: `Delete me ${runId}` });
      await runCrmTool('addTaskToList', { taskListId, task: `Delete me too ${runId}` });
      const before = await tasks.countDocuments({ taskListId });
      assert.equal(before >= 2, true);

      const deleted = await runCrmTool('deleteTaskList', { taskListId, confirm: true });
      assert.equal(deleted.ok, true);

      const remaining = await tasks.countDocuments({ taskListId });
      assert.equal(remaining, 0);
    } finally {
      if (taskListId) {
        await tasks.deleteMany({ taskListId });
      }
      await client.close();
    }
  });
}
