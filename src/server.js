import { createServer } from "node:http";
import { loadContext } from "./catalog.js";
import { buildApp } from "./app/http-app.js";
import { bootstrapService } from "./app/bootstrap.js";
import { DomainError } from "./app/roles.js";

const service = await bootstrapService();
const app = buildApp({ service });

const server = createServer(async (request, response) => {
  if (request.url === "/context") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(await loadContext()));
    return;
  }
  try {
    const { status, body } = await app.handle(request);
    response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    response.end(body == null ? "" : JSON.stringify(body, null, 2));
  } catch (error) {
    const status = error instanceof DomainError ? error.status ?? 400 : 500;
    response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    response.end(
      JSON.stringify(
        {
          error: error.message,
          code: error.code ?? "INTERNAL",
          ...(error.gates ? { gates: error.gates } : {}),
        },
        null,
        2,
      ),
    );
  }
});

const port = Number(process.env.PORT ?? 8000);
server.listen(port, "127.0.0.1", () => {
  console.log(`射击成绩与纪录后台已启动：http://127.0.0.1:${port}`);
});

export { server, service };
