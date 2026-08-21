import { createServer } from "node:http";
import { once } from "node:events";
import { runCli } from "../../../scripts/inspect-oci-image.mjs";
import { makeInspectionFixture } from "../integration/inspect-oci-image-fixtures.mjs";

const scenario = process.argv.length === 3 ? process.argv[2] : null;
if (!new Set(["success", "usage-error", "signal-stream"]).has(scenario)) {
  process.stderr.write("invalid child fixture scenario\n");
  process.exitCode = 2;
} else {
  let server;
  try {
    const fixture = makeInspectionFixture();
    server = createServer((request, response) => {
      if (scenario === "signal-stream") {
        response.writeHead(200, {
          "Content-Type": "application/vnd.oci.image.index.v1+json",
          "Docker-Content-Digest": fixture.digest,
        });
        response.write("{");
        return;
      }
      const artifact = fixture.artifacts.get(request.url?.split("?")[0] ?? "");
      if (!artifact) {
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end("{}");
        return;
      }
      response.writeHead(200, {
        "Content-Type": artifact.contentType,
        "Content-Encoding": "identity",
        "Docker-Content-Digest": artifact.dockerDigest,
      });
      response.end(artifact.body);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture server failed");
    const origin = `http://127.0.0.1:${address.port}`;
    let signalScheduled = false;
    const transport = (request) => {
      process.send?.("transport-called");
      if (scenario === "signal-stream" && !signalScheduled) {
        signalScheduled = true;
        setTimeout(() => process.emit("SIGTERM"), 50);
      }
      const logical = new URL(request.url);
      return fetch(`${origin}${logical.pathname}${logical.search}`, {
        method: request.method,
        headers: request.headers,
        redirect: request.redirect,
        signal: request.signal,
      });
    };
    const argv = scenario === "usage-error"
      ? ["--image", "https://ghcr.io/felixgeisler/draw:edge"]
      : ["--image", "ghcr.io/felixgeisler/draw:edge"];
    process.exitCode = await runCli({
      argv,
      env: {},
      stdout: process.stdout,
      stderr: process.stderr,
      transport,
      signals: process,
    });
  } finally {
    server?.closeAllConnections();
    server?.close();
  }
}
