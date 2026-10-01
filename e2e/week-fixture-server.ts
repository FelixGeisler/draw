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

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void close().then(() => process.exit(0), (error) => {
    console.error(error);
    process.exit(1);
  }));
}
