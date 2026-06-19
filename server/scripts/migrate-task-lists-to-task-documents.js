import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';

const {
  MONGO_URI = '',
  MONGO_DB_NAME = 'sales_data',
  MONGO_TASK_LISTS_COLLECTION = 'taskLists',
  MONGO_TASKS_COLLECTION = 'tasks'
} = process.env;

if (!MONGO_URI) {
  console.error('MONGO_URI is required');
  process.exit(1);
}

const shouldExecute = process.argv.includes('--execute');
const shouldAssert = process.argv.includes('--assert');
const dryRun = !shouldExecute;

function toObjectId(value) {
  try {
    return new ObjectId(value);
  } catch (_err) {
    return null;
  }
}

function normalizeTaskPerson(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  if (value.name != null && String(value.name).trim()) out.name = String(value.name).trim();
  if (value.title != null && String(value.title).trim()) out.title = String(value.title).trim();
  if (value.role != null && String(value.role).trim()) out.role = String(value.role).trim();
  return Object.keys(out).length ? out : null;
}

function normalizeIso(value, fallback) {
  const text = String(value || '').trim();
  if (!text) return fallback;
  return text;
}

function buildTaskDocument(taskListRow, embeddedTask, idx) {
  const nowIso = new Date().toISOString();
  const listId = String(taskListRow._id);
  const listName = taskListRow.name ? String(taskListRow.name) : null;
  const rawTaskId = embeddedTask?.taskId ? String(embeddedTask.taskId).trim() : '';
  const stableTaskId = rawTaskId || `${listId}:embedded:${idx}`;
  const explicitObjectId = toObjectId(stableTaskId);
  const taskDoc = {
    taskId: stableTaskId,
    legacyTaskId: rawTaskId || null,
    taskListId: listId,
    taskListName: listName,
    task: embeddedTask?.task != null ? String(embeddedTask.task) : '',
    status: embeddedTask?.status ? String(embeddedTask.status) : 'open',
    priority: embeddedTask?.priority ? String(embeddedTask.priority) : null,
    dueDate: embeddedTask?.dueDate ? String(embeddedTask.dueDate) : null,
    person: normalizeTaskPerson(embeddedTask?.person),
    accountId: embeddedTask?.accountId ? String(embeddedTask.accountId) : null,
    workloadId: embeddedTask?.workloadId ? String(embeddedTask.workloadId) : null,
    createdAt: normalizeIso(embeddedTask?.createdAt, nowIso),
    updatedAt: normalizeIso(embeddedTask?.updatedAt, nowIso)
  };
  if (!taskDoc.legacyTaskId) delete taskDoc.legacyTaskId;
  if (!taskDoc.priority) delete taskDoc.priority;
  if (!taskDoc.dueDate) taskDoc.dueDate = null;
  if (!taskDoc.person) delete taskDoc.person;
  if (!taskDoc.accountId) taskDoc.accountId = null;
  if (!taskDoc.workloadId) taskDoc.workloadId = null;
  return { taskDoc, explicitObjectId };
}

async function run() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  try {
    const db = client.db(MONGO_DB_NAME);
    const taskLists = db.collection(MONGO_TASK_LISTS_COLLECTION);
    const tasks = db.collection(MONGO_TASKS_COLLECTION);

    const listRows = await taskLists.find({}).project({ name: 1, owner: 1, tasks: 1, updatedAt: 1 }).toArray();
    const preEmbeddedTaskCount = listRows.reduce((sum, row) => {
      const embedded = Array.isArray(row?.tasks) ? row.tasks.length : 0;
      return sum + embedded;
    }, 0);
    const migrationListIds = listRows.map((row) => String(row._id));

    let scannedLists = 0;
    let listsWithEmbeddedTasks = 0;
    let upsertedTasks = 0;
    let updatedExistingTasks = 0;
    let removedEmbeddedArrays = 0;
    const sample = [];

    for (const row of listRows) {
      scannedLists += 1;
      const embeddedTasks = Array.isArray(row?.tasks) ? row.tasks : [];
      if (!embeddedTasks.length) continue;
      listsWithEmbeddedTasks += 1;

      for (let i = 0; i < embeddedTasks.length; i += 1) {
        const { taskDoc, explicitObjectId } = buildTaskDocument(row, embeddedTasks[i], i);
        const upsertFilter = { taskListId: taskDoc.taskListId, taskId: taskDoc.taskId };
        const setDoc = { ...taskDoc };
        delete setDoc.createdAt;
        const updatePayload = {
          $set: setDoc,
          $setOnInsert: {
            createdAt: taskDoc.createdAt
          }
        };
        if (explicitObjectId) {
          updatePayload.$setOnInsert._id = explicitObjectId;
        }
        if (!dryRun) {
          const result = await tasks.updateOne(upsertFilter, updatePayload, { upsert: true });
          if (result.upsertedCount) upsertedTasks += 1;
          else if (result.matchedCount) updatedExistingTasks += 1;
        } else {
          upsertedTasks += 1;
        }
        if (sample.length < 20) {
          sample.push({
            taskListId: taskDoc.taskListId,
            taskId: taskDoc.taskId,
            task: taskDoc.task
          });
        }
      }

      if (!dryRun) {
        await taskLists.updateOne(
          { _id: row._id },
          {
            $unset: { tasks: '' },
            $set: {
              updatedAt: new Date().toISOString(),
              taskModelMigratedAt: new Date().toISOString()
            }
          }
        );
        removedEmbeddedArrays += 1;
      }
    }

    const postTaskCount = migrationListIds.length
      ? await tasks.countDocuments({ taskListId: { $in: migrationListIds } })
      : 0;
    const remainingEmbeddedCount = await taskLists.countDocuments({ tasks: { $exists: true, $type: 'array', $ne: [] } });

    const summary = {
      mode: dryRun ? 'dry-run' : 'execute',
      scannedLists,
      listsWithEmbeddedTasks,
      preEmbeddedTaskCount,
      upsertedTasks,
      updatedExistingTasks,
      removedEmbeddedArrays: dryRun ? 0 : removedEmbeddedArrays,
      postTaskCount,
      remainingEmbeddedCount,
      sample
    };
    console.log(JSON.stringify(summary, null, 2));

    if (shouldAssert) {
      if (postTaskCount < preEmbeddedTaskCount) {
        throw new Error(`Validation failed: postTaskCount (${postTaskCount}) is less than preEmbeddedTaskCount (${preEmbeddedTaskCount})`);
      }
      if (!dryRun && remainingEmbeddedCount > 0) {
        throw new Error(`Validation failed: ${remainingEmbeddedCount} task lists still contain embedded tasks.`);
      }
    }
  } finally {
    await client.close();
  }
}

run().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
