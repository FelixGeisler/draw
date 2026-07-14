import "dotenv/config";
import { startServer } from "./server.js";

startServer(Number(process.env.API_PORT) || 3001);
