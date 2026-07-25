import "dotenv/config";
import { resolveApiPort } from "./config.js";
import { startServer } from "./server.js";

startServer(resolveApiPort());
