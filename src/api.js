import { loadContext } from "./catalog.js";
import { DomainError, badRequest } from "./domain/errors.js";

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw badRequest("请求体不是合法 JSON");
  }
}

function send(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

/**
 * 路由表。角色经 x-role 请求头传入（audience / referee / technical_delegate），
 * 缺省按观众处理；时区经 ?zone= 查询参数传入。
 */
export function createHandler(service) {
  const routes = [
    ["GET", /^\/health$/, async () => ({ status: "ok" })],
    ["GET", /^\/context$/, async () => loadContext()],
    ["POST", /^\/matches$/, async ({ body }) => service.registerMatch(body), 201],
    ["POST", /^\/matches\/([^/]+)\/athletes$/, async ({ body, params }) => service.enterAthlete(params[0], body), 201],
    ["POST", /^\/matches\/([^/]+)\/shots$/, async ({ body, params }) => service.recordShot(params[0], body), 201],
    ["POST", /^\/matches\/([^/]+)\/corrections$/, async ({ body, params }) => service.correct(params[0], body), 201],
    ["POST", /^\/matches\/([^/]+)\/scorecards\/([^/]+)\/review$/, async ({ body, params }) => service.reviewScorecard(params[0], params[1], body)],
    ["POST", /^\/matches\/([^/]+)\/scorecards\/([^/]+)\/confirm$/, async ({ body, params }) => service.confirmScorecard(params[0], params[1], body)],
    ["POST", /^\/matches\/([^/]+)\/appeals$/, async ({ body, params }) => service.fileAppeal(params[0], body), 201],
    ["POST", /^\/matches\/([^/]+)\/appeals\/([^/]+)\/resolve$/, async ({ body, params }) => service.resolveAppeal(params[0], params[1], body)],
    ["GET", /^\/matches\/([^/]+)\/scorecards$/, async ({ params, role }) => service.scorecards(params[0], role)],
    ["GET", /^\/matches\/([^/]+)\/scorecards\/([^/]+)$/, async ({ params, role }) => service.scorecard(params[0], params[1], role)],
    ["GET", /^\/matches\/([^/]+)\/rankings\/(individual|team)$/, async ({ params, role }) => service.rankings(params[0], params[1], role)],
    ["GET", /^\/matches\/([^/]+)\/timeline$/, async ({ params, role, zone }) => service.timeline(params[0], role, zone)],
    ["GET", /^\/records$/, async ({ role }) => service.records(role)],
    ["POST", /^\/records\/([^/]+)\/approvals$/, async ({ body, params, role }) => service.approveRecordStep(params[0], body, role), 201],
    ["GET", /^\/records\/([^/]+)\/replay$/, async ({ params, role }) => service.replayRecord(params[0], role)],
  ];

  return async function handler(request, response) {
    const url = new URL(request.url, "http://localhost");
    const role = request.headers["x-role"] ?? "audience";
    const zone = url.searchParams.get("zone") ?? undefined;
    try {
      for (const [method, pattern, action, status = 200] of routes) {
        const match = pattern.exec(url.pathname);
        if (request.method === method && match) {
          const body = method === "POST" ? await readBody(request) : {};
          const result = await action({ body, params: match.slice(1), role, zone });
          send(response, status, result ?? {});
          return;
        }
      }
      send(response, 404, { error: { code: "not_found", message: "路由不存在" } });
    } catch (error) {
      if (error instanceof DomainError) {
        send(response, error.status, { error: { code: error.code, message: error.message } });
      } else {
        send(response, 500, { error: { code: "internal", message: "服务内部错误" } });
      }
    }
  };
}
