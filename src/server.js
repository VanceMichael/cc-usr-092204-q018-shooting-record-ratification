import { createServer } from "node:http";
import { ShootingService } from "./service.js";
import { createHandler } from "./api.js";

const service = new ShootingService();
const server = createServer(createHandler(service));

server.listen(8000, "127.0.0.1");
