const fs = require('node:fs/promises');
const path = require('node:path');

function segment(value, label) {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[\\/\x00]/.test(value)) {
    throw new Error(`${label} 无效`);
  }
  return value;
}

function workspacePaths(root, call) {
  const runId = segment(String(call.runId), 'runId');
  const stepId = segment(String(call.stepId), 'stepId');
  const toolCallId = segment(String(call.id), 'toolCallId');
  const runRoot = path.join(root, 'runs', runId);
  const taskRoot = path.join(runRoot, stepId, toolCallId);
  return {
    runRoot,
    taskRoot,
    input: path.join(taskRoot, 'input'),
    work: path.join(taskRoot, 'work'),
    output: path.join(taskRoot, 'output'),
    logs: path.join(taskRoot, 'logs'),
  };
}

async function ensureWorkspace(root, call) {
  const paths = workspacePaths(root, call);
  await Promise.all(Object.values(paths).map((directory) => fs.mkdir(directory, { recursive: true })));
  const metadata = path.join(paths.taskRoot, 'workspace.json');
  try {
    await fs.access(metadata);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await fs.writeFile(metadata, JSON.stringify({
      runId: String(call.runId),
      stepId: String(call.stepId),
      toolCallId: String(call.id),
      createdAt: new Date().toISOString(),
      state: 'running',
    }, null, 2), 'utf8');
  }
  return paths;
}

async function updateWorkspaceState(paths, state) {
  const metadata = path.join(paths.taskRoot, 'workspace.json');
  try {
    const current = JSON.parse(await fs.readFile(metadata, 'utf8'));
    current.state = state;
    current.updatedAt = new Date().toISOString();
    await fs.writeFile(metadata, JSON.stringify(current, null, 2), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function clearWork(paths) {
  await fs.rm(paths.work, { recursive: true, force: true });
  await fs.mkdir(paths.work, { recursive: true });
}

async function directorySize(directory) {
  let total = 0;
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directorySize(target);
    else if (entry.isFile()) total += (await fs.stat(target)).size;
  }
  return total;
}

async function cleanupWorkspace(identityRoot, { ttlHours = 24, maxBytes = 2 * 1024 * 1024 * 1024, terminalRunIds = [] } = {}) {
  const terminalRuns = new Set(terminalRunIds);
  const runsRoot = path.join(identityRoot, 'runs');
  let entries;
  try { entries = await fs.readdir(runsRoot, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return { removed: 0, bytes: 0 }; throw error; }
  const cutoff = Date.now() - Math.max(1, ttlHours) * 60 * 60 * 1000;
  const candidates = [];
  const protectedRuns = new Set();
  const terminalJournals = [];
  const journalRoot = path.join(identityRoot, 'journals');
  for (const name of await fs.readdir(journalRoot).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  })) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(journalRoot, name);
    try {
      const journal = JSON.parse(await fs.readFile(file, 'utf8'));
      const runId = segment(String(journal.call.runId), 'runId');
      if (!['acknowledged', 'discarded'].includes(journal.state)) protectedRuns.add(runId);
      else terminalJournals.push({ file, runId, timestamp: Date.parse(journal.acknowledgedAt || journal.discardedAt || '') });
    } catch {
      // A corrupt receipt must remain available for diagnosis; do not guess its run.
      return { removed: 0, bytes: 0 };
    }
  }
  let total = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const target = path.join(runsRoot, entry.name);
    const bytes = await directorySize(target);
    total += bytes;
    if (protectedRuns.has(entry.name) || !terminalRuns.has(entry.name)) continue;
    let eligible = true;
    let timestamp = 0;
    let tasks = 0;
    for (const step of await fs.readdir(target, { withFileTypes: true })) {
      if (!step.isDirectory()) continue;
      for (const call of await fs.readdir(path.join(target, step.name), { withFileTypes: true })) {
        if (!call.isDirectory()) continue;
        tasks++;
        try {
          const metadata = JSON.parse(await fs.readFile(path.join(target, step.name, call.name, 'workspace.json'), 'utf8'));
          const updatedAt = Date.parse(metadata.updatedAt || '');
          if (!['acknowledged', 'discarded'].includes(metadata.state) || !Number.isFinite(updatedAt)) eligible = false;
          timestamp = Math.max(timestamp, updatedAt);
        } catch { eligible = false; }
      }
    }
    if (eligible && tasks) candidates.push({ target, timestamp, bytes });
  }
  // Only confirmed receipts (or explicit server rejection) permit deletion.
  // Running jobs and unacknowledged side effects survive restarts and disk pressure.
  candidates.sort((a, b) => a.timestamp - b.timestamp);
  let removed = 0;
  let removedBytes = 0;
  for (const candidate of candidates) {
    if (candidate.timestamp < cutoff || total > maxBytes) {
      await fs.rm(candidate.target, { recursive: true, force: true });
      total -= candidate.bytes;
      removed += 1;
      removedBytes += candidate.bytes;
    }
  }
  for (const journal of terminalJournals) {
    if (journal.timestamp < cutoff && terminalRuns.has(journal.runId) && !protectedRuns.has(journal.runId)) await fs.rm(journal.file, { force: true });
  }
  return { removed, bytes: removedBytes };
}

module.exports = { workspacePaths, ensureWorkspace, updateWorkspaceState, clearWork, cleanupWorkspace, directorySize };
