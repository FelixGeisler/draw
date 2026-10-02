import { createApp } from "../server/src/app.js";
import {
  beginWeekIntervalMutation,
  checkpointAndCloseLiveDatabaseForSwap,
  db,
  finalizeWeekIntervalMutation,
  maintainFixedIntervalWrite,
  reprojectTrackedIntervals,
  shutdownWeekProjection,
} from "../server/src/db.js";
import { seedHistoricalWeek } from "./week-fixtures.js";

seedHistoricalWeek({
  db,
  maintainFixedIntervalWrite,
  beginWeekIntervalMutation,
  reprojectTrackedIntervals: (token, ids) => reprojectTrackedIntervals(token as never, ids),
  finalizeWeekIntervalMutation: (token) => finalizeWeekIntervalMutation(token as never),
});

const server = createApp().listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing fixture listener");
  process.stdout.write(`${JSON.stringify({ port: address.port })}\n`);
});

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  await shutdownWeekProjection();
  checkpointAndCloseLiveDatabaseForSwap();
}

async function closeAndExit(acknowledge = false) {
  try {
    await close();
    if (acknowledge && process.send) {
      await new Promise<void>((resolve, reject) => {
        process.send!({ type: "shutdown-complete" }, (error) => error ? reject(error) : resolve());
      });
    }
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

// IPC is the cross-platform graceful path used by Playwright. Unlike POSIX
// signals on Windows, the acknowledgement proves listener, Week worker, and
// live SQLite closure completed before process exit.
process.on("message", (message) => {
  if (message && typeof message === "object" && "type" in message && message.type === "shutdown") {
    void closeAndExit(true);
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void closeAndExit());
}
