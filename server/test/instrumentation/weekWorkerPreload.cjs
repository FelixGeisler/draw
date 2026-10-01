const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { registerHooks } = require("node:module");
const { parentPort, threadId } = require("node:worker_threads");

const eventFile = process.env.DRAW_WEEK_TEST_EVENT_FILE;
const mode = process.env.DRAW_WEEK_TEST_MODE || "observe";
let sequence = 0;
function event(type, detail = {}) {
  const row = { sequence: ++sequence, pid: process.pid, threadId, type, ...detail };
  if (eventFile) fs.appendFileSync(eventFile, `${JSON.stringify(row)}\n`);
}

if (!parentPort) throw new Error("Week worker instrumentation requires a parent port");

const shimUrl = pathToFileURL(path.join(__dirname, "weekDatabaseShim.mjs")).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "better-sqlite3" && context.parentURL !== shimUrl) {
      return { url: shimUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const originalPostMessage = parentPort.postMessage.bind(parentPort);
parentPort.postMessage = (message, transfer) => {
  let outgoing = message;
  if (message?.type) event("worker-message", { messageType: message.type, code: message.code });
  if (message?.type === "result") {
    const serialized = JSON.stringify(message);
    event("result-ipc", {
      records: Array.isArray(message.records) ? message.records.length : -1,
      bytes: Buffer.byteLength(serialized),
      containsForbiddenSuffix: process.env.DRAW_WEEK_FORBIDDEN_SUFFIX
        ? serialized.includes(process.env.DRAW_WEEK_FORBIDDEN_SUFFIX)
        : false,
    });
    if (mode === "worker-failure") {
      outgoing = { type: "failure", id: message.id, code: "failed", discard: true };
    }
    if (mode === "protocol") outgoing = { ...message, records: "invalid-record-array" };
    if (mode === "structural") outgoing = { ...message, hasMore: true, last: null };
  }
  return originalPostMessage(outgoing, transfer);
};

event("preload-ready", { mode });
