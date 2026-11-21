import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { dispatchRoutes } from "../routes/table.ts";
import { FakeDataDatabase } from "../testing/fake-data-database.ts";
import { createDataRoutes, dataErrorStatus, type DataRouteDeps } from "./routes.ts";
import { createDataEngine } from "./engine.ts";
import { DataSheetRegistry } from "./sheet.ts";
import { showCard, type DataContext, type ShowInput } from "./tools.ts";
import { DataFailure, type DataEngine } from "./types.ts";

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function serve(overrides: Partial<DataRouteDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "madani-data-routes-"));
  dirs.push(dir);
  const database = new FakeDataDatabase("bot-1");
  database.tables.set("orders", { columns: [{ name: "id", type: "INTEGER" }, { name: "total", type: "DOUBLE" }], rows: [[1, 9.5], [2, 3.25], [3, 7]] });
  const frames: unknown[] = [];
  const sheets = new DataSheetRegistry({ broadcast: (frame) => frames.push(frame), dropResult: (_bot, name) => database.dropResult(name), dir: (botId) => join(dir, "bots", botId) });
  const deps: DataRouteDeps = {
    bot: (id) => (id === "bot-1" ? { id, cwd: join(dir, "work") } : undefined),
    engine: { unavailable: () => null, forBot: async () => database },
    sheets,
    compileChart: (spec, _columns, from) => ({ sql: `SELECT ${spec.x} AS x, count(*) AS y FROM ${from} GROUP BY ALL`, vegaLite: { mark: spec.type }, reduction: { method: "group" } }),
    validateVegaLite: async (spec) => spec as Record<string, unknown>,
    renderer: { svg: async (_s, rows) => `<svg>${rows.length}</svg>`, png: async (_s, rows, _c, options) => Buffer.from(`png ${rows.length} ${options.theme} ${options.width ?? "-"} ${options.scale ?? "-"}`) },
    exportRoots: (bot) => [bot.cwd ?? dir],
    ...overrides,
  };
  const routes = [createDataRoutes(deps)];
  // cards come from the bot's data_show tool; the routes only read them
  const show = async (input: ShowInput) => {
    const context: DataContext = {
      database: await (deps.engine as Pick<DataEngine, "forBot">).forBot("bot-1"), sheet: sheets.for("bot-1"),
      compileChart: deps.compileChart, validateVegaLite: deps.validateVegaLite, renderer: deps.renderer,
      exportRoots: () => [dir], signal: new AbortController().signal, connection: "bot", by: "bot",
    };
    return showCard(context, { kind: "table", ...input });
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: { kind: "loopback", scopes: ["admin"] } as never, json, readBody });
      if (!handled) json(res, 404, { from: "inline routes" });
    } catch (error) {
      json(res, 500, { error: String(error) });
    }
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const type = response.headers.get("content-type") ?? "";
    return { status: response.status, type, body: type.startsWith("image/") ? Buffer.from(await response.arrayBuffer()) : await response.json() as any };
  };
  return { call, show, database, sheets, frames, dir, base };
}

describe("the Data routes", () => {
  it("passes on other paths and answers the sheet with the loaded tables", async () => {
    const { call } = await serve();
    expect((await call("GET", "/api/bots/bot-1/memory")).body).toEqual({ from: "inline routes" });
    expect((await call("GET", "/api/bots/bot-1/browser/live")).body).toEqual({ from: "inline routes" });
    const sheet = await call("GET", "/api/bots/bot-1/data");
    expect(sheet.status).toBe(200);
    expect(sheet.body.sheet).toMatchObject({ version: 1, botId: "bot-1", cards: [], sources: [] });
    expect(sheet.body.tables).toEqual([{ name: "orders", rowCount: 3, columns: [{ name: "id", type: "INTEGER" }, { name: "total", type: "DOUBLE" }] }]);
    expect((await call("GET", "/api/bots/nobody/data")).status).toBe(404);
    expect((await call("GET", "/api/bots/bot-1/data/nothing")).status).toBe(400);
  });

  it("reads the sheet without writing it or telling every client about the catalog", async () => {
    const { call, frames, dir } = await serve();
    await call("GET", "/api/bots/bot-1/data");
    const read = await call("GET", "/api/bots/bot-1/data");
    expect(read.body.sheet).not.toHaveProperty("tables");
    expect(read.body.tables.map((table: { name: string }) => table.name)).toEqual(["orders"]);
    expect(frames).toEqual([]);
    expect(existsSync(join(dir, "bots", "bot-1", "sheet.json"))).toBe(false);
  });

  it("answers 503 engine_unavailable before touching anything when DuckDB cannot run", async () => {
    const { call, database } = await serve({ engine: { unavailable: () => "the DuckDB binding did not load", forBot: async () => { throw new Error("never"); } } });
    const reply = await call("GET", "/api/bots/bot-1/data");
    expect(reply.status).toBe(503);
    expect(reply.body).toEqual({ error: { code: "engine_unavailable", message: "the DuckDB binding did not load" } });
    expect(database.calls).toEqual([]);
  });

  it("pages a bot's card and the source tables", async () => {
    const { call, show, database } = await serve();
    database.next = { columns: [{ name: "id", type: "INTEGER" }], rows: [[1], [2]], rowCount: 2 };
    expect(await show({ sql: "SELECT id FROM orders", title: "Ids" })).toMatchObject({ id: "c_1", rowCount: 2 });
    const page = await call("POST", "/api/bots/bot-1/data/page", { cardId: "c_1", offset: 0, limit: 10 });
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ rowCount: 2, offset: 0, rows: [[1], [2]] });
    expect(database.calls.at(-1)).toMatchObject({ method: "page", target: 'madani_results."c_1"' });

    const tablePage = await call("POST", "/api/bots/bot-1/data/page", { table: "orders", offset: 1, limit: 1 });
    expect(tablePage.body.rows).toEqual([[2, 3.25]]);
    expect((await call("POST", "/api/bots/bot-1/data/page", { table: "orders", cardId: "c_1", offset: 0, limit: 1 })).status).toBe(400);
    expect((await call("POST", "/api/bots/bot-1/data/page", { table: "orders", offset: 0, limit: 5000 })).status).toBe(400);
    expect((await call("POST", "/api/bots/bot-1/data/page", { cardId: "c_8", offset: 0, limit: 5 })).status).toBe(404);
    expect((await call("POST", "/api/bots/bot-1/data/page", "not json")).status).toBe(400);
  });

  it("has no routes for editing, cancelling, deleting, exploring or exporting from the app", async () => {
    const { call, show, sheets } = await serve();
    await show({ sql: "SELECT id FROM orders", title: "Ids" });
    const before = sheets.for("bot-1").cards();
    for (const [method, path] of [
      ["POST", "/api/bots/bot-1/data/run"], ["POST", "/api/bots/bot-1/data/cancel"], ["POST", "/api/bots/bot-1/data/export"],
      ["PATCH", "/api/bots/bot-1/data/cards/c_1"], ["DELETE", "/api/bots/bot-1/data/cards/c_1"],
      ["GET", "/api/bots/bot-1/data/tables/orders/stats"], ["GET", "/api/bots/bot-1/data/tables/orders/histogram?column=total"],
    ] as const) {
      const reply = await call(method, path, method === "GET" || method === "DELETE" ? undefined : { sql: "SELECT 1", cardId: "c_1", title: "x", format: "csv" });
      expect(reply.status, `${method} ${path}`).toBe(400);
      expect(reply.body.error.code).toBe("invalid_input");
    }
    expect(sheets.for("bot-1").cards()).toEqual(before);
  });

  it("pages column-filtered results through real DuckDB and rejects stale column names even with no text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "madani-data-column-filter-"));
    dirs.push(dir);
    const engine = createDataEngine({ dataDir: dir, botFolder: (id) => join(dir, id) });
    try {
      const { call, show } = await serve({ engine });
      const created = await show({ sql: "SELECT range::INTEGER AS id, CASE WHEN range % 2 = 0 THEN 'needle' ELSE 'other' END AS label, CASE WHEN range % 2 = 1 THEN 'needle' ELSE 'other' END AS notes FROM range(30)" });
      const query = { cardId: created.id, offset: 1, limit: 2, filter: "needle", sort: { column: "id", direction: "desc" } };
      const scoped = await call("POST", "/api/bots/bot-1/data/page", { ...query, filterColumn: "label" });
      expect(scoped).toMatchObject({ status: 200, body: { rowCount: 15, offset: 1, rows: [[26, "needle", "other"], [24, "needle", "other"]] } });
      expect((await call("POST", "/api/bots/bot-1/data/page", query)).body.rowCount).toBe(30);
      for (const filter of [undefined, ""]) {
        expect(await call("POST", "/api/bots/bot-1/data/page", { ...query, filter, filterColumn: "removed" })).toMatchObject({ status: 400, body: { error: { code: "invalid_input", message: expect.stringContaining("removed") } } });
      }
      for (const filterColumn of ["", "x".repeat(301), 1, null]) {
        expect((await call("POST", "/api/bots/bot-1/data/page", { ...query, filterColumn })).status).toBe(400);
      }
      expect((await call("POST", "/api/bots/bot-1/data/page", { ...query, filter: "", filterColumn: "label" })).body.rowCount).toBe(30);
    } finally {
      await engine.closeAll();
    }
  });

  it("maps missing tables and engine errors to the error envelope", async () => {
    const { call, database } = await serve();
    const missing = await call("POST", "/api/bots/bot-1/data/page", { table: "nope", offset: 0, limit: 5 });
    expect(missing.status).toBe(404);
    expect(missing.body.error).toMatchObject({ code: "table_not_found", candidates: ["orders"] });
    database.failNext = new DataFailure({ code: "sql_error", message: "Binder Error: no", line: 1 });
    const failed = await call("POST", "/api/bots/bot-1/data/page", { table: "orders", offset: 0, limit: 5 });
    expect(failed.status).toBe(422);
    expect(failed.body.error).toMatchObject({ code: "sql_error", line: 1 });
    expect(dataErrorStatus("write_refused")).toBe(409);
    expect(dataErrorStatus("output_too_large")).toBe(422);
    expect(dataErrorStatus("timeout")).toBe(503);
  });

  it("renders a chart card's image", async () => {
    const { call, show } = await serve();
    await show({ sql: "SELECT id FROM orders", title: "Ids" });
    const notChart = await call("GET", "/api/bots/bot-1/data/cards/c_1/image");
    expect(notChart.status).toBe(400);

    await show({ sql: "SELECT * FROM orders", kind: "chart", chart: { type: "pie", x: "id" }, title: "Share" });
    const png = await call("GET", "/api/bots/bot-1/data/cards/c_2/image?theme=dark&width=640&scale=2");
    expect(png.status).toBe(200);
    expect(png.type).toBe("image/png");
    expect((png.body as Buffer).toString()).toBe("png 3 dark 640 2");
    const svg = await call("GET", "/api/bots/bot-1/data/cards/c_2/image?format=svg");
    expect(svg.type).toContain("image/svg+xml");
    expect((svg.body as Buffer).toString()).toBe("<svg>3</svg>");
    expect((await call("GET", "/api/bots/bot-1/data/cards/c_9/image")).status).toBe(404);
  });
});
