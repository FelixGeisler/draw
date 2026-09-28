import request from "supertest";
import { parentPort } from "node:worker_threads";
import { createApp } from "../../src/app.js";

type RequestCommand = {
  type: "request";
  method: "get" | "post" | "patch";
  url: string;
  body?: unknown;
};

if (!parentPort) throw new Error("concurrent request helper requires a worker parent");
const port = parentPort;

const app = createApp();
port.postMessage({ type: "ready" });

port.on("message", async (message: RequestCommand) => {
  if (message?.type !== "request") return;
  port.postMessage({ type: "attempting" });
  try {
    const pending = request(app)[message.method](message.url);
    const response = message.body === undefined
      ? await pending
      : await pending.send(message.body as string | object);
    port.postMessage({ type: "result", status: response.status, body: response.body });
  } catch (error) {
    port.postMessage({
      type: "failure",
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    });
  }
});
