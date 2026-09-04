import { timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";

import {
  TRANSITION_REASONS,
  WORK_ITEM_PRIORITIES,
  WORK_ITEM_STATUSES,
  WORK_ITEM_TYPES,
  type WorkItemEnvironment,
} from "@missiongo/domain";

import { AttachmentStorage, MAX_ATTACHMENT_BYTES } from "./attachment-storage.js";
import { invalidInput, MissionGoError } from "./errors.js";
import { createMissionGoMcpHandler } from "./mcp.js";
import { MissionGoStore } from "./store.js";
import { COMPONENT_KINDS, type ComponentKind } from "./types.js";

export interface BuildAppOptions {
  readonly databasePath?: string;
  readonly logger?: FastifyServerOptions["logger"];
  readonly adminToken?: string;
  readonly mcpToken?: string;
  readonly attachmentsPath?: string;
}

const ENVIRONMENT_PLATFORMS = ["android", "macos", "web", "server", "shared", "other"] as const;

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidInput("A JSON object is required.");
  return value as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, field: string, required = true): string | undefined {
  const value = body[field];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string") throw invalidInput(`${field} must be a string.`);
  return value;
}

function stringArrayField(body: Record<string, unknown>, field: string): readonly string[] | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw invalidInput(`${field} must be an array of strings.`);
  }
  return value as string[];
}

function enumField<T extends string>(
  body: Record<string, unknown>,
  field: string,
  choices: readonly T[],
  required = true,
): T | undefined {
  const value = body[field];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !choices.includes(value as T)) {
    throw invalidInput(`${field} must be one of: ${choices.join(", ")}.`);
  }
  return value as T;
}

function environmentBody(value: unknown, allowNull = false): WorkItemEnvironment | null | undefined {
  if (value === undefined) return undefined;
  if (value === null && allowNull) return null;
  const body = objectBody(value);
  const platform = enumField(body, "platform", ENVIRONMENT_PLATFORMS)!;
  const optionalText = (field: string): string | undefined => {
    const result = stringField(body, field, false)?.trim();
    if (result && result.length > 500) throw invalidInput(`${field} must be 500 characters or fewer.`);
    return result || undefined;
  };

  const metadataValue = body.metadata;
  let metadata: Readonly<Record<string, string>> | undefined;
  if (metadataValue !== undefined) {
    if (!metadataValue || typeof metadataValue !== "object" || Array.isArray(metadataValue)) {
      throw invalidInput("environment.metadata must be an object of string values.");
    }
    const entries = Object.entries(metadataValue);
    if (entries.length > 50 || entries.some(([key, entry]) => !key.trim() || key.length > 100 || typeof entry !== "string" || entry.length > 2_000)) {
      throw invalidInput("environment.metadata contains an invalid key or value.");
    }
    metadata = Object.fromEntries(entries);
  }

  const appVersion = optionalText("appVersion");
  const buildNumber = optionalText("buildNumber");
  const sourceRevision = optionalText("sourceRevision");
  const osVersion = optionalText("osVersion");
  const deviceModel = optionalText("deviceModel");
  return {
    platform,
    ...(appVersion ? { appVersion } : {}),
    ...(buildNumber ? { buildNumber } : {}),
    ...(sourceRevision ? { sourceRevision } : {}),
    ...(osVersion ? { osVersion } : {}),
    ...(deviceModel ? { deviceModel } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function headerText(value: string | string[] | undefined, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw invalidInput(`${name} header is required.`);
  return value.trim();
}

function publicAttachment<T extends { readonly storageFilename: string }>(attachment: T): Omit<T, "storageFilename"> {
  const { storageFilename: _, ...visible } = attachment;
  return visible;
}

function hasBearerToken(authorization: string | undefined, token: string): boolean {
  const suppliedToken = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  const expected = Buffer.from(token);
  const supplied = Buffer.from(suppliedToken);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });
  const store = new MissionGoStore(options.databasePath ?? ":memory:");
  const attachmentStorage = new AttachmentStorage(options.attachmentsPath ?? "./data/attachments");
  const mcpHandler = options.mcpToken ? createMissionGoMcpHandler(store, attachmentStorage) : undefined;

  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: MAX_ATTACHMENT_BYTES },
    (_request, body, done) => done(null, body),
  );

  app.decorate("missionGoStore", store);
  app.addHook("onClose", async () => {
    await mcpHandler?.close();
    store.close();
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/v1/") || !options.adminToken) return;
    if (!hasBearerToken(request.headers.authorization, options.adminToken)) {
      return reply.status(401).send({
        type: "urn:missiongo:problem:authentication_required",
        title: "A valid bearer token is required.",
        status: 401,
        code: "authentication_required",
      });
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof MissionGoError) {
      return reply.status(error.statusCode).send({
        type: `urn:missiongo:problem:${error.code}`,
        title: error.message,
        status: error.statusCode,
        code: error.code,
      });
    }

    app.log.error(error);
    return reply.status(500).send({
      type: "urn:missiongo:problem:internal_error",
      title: "An unexpected error occurred.",
      status: 500,
      code: "internal_error",
    });
  });

  app.get("/health", async () => ({ status: "ok" }));

  if (mcpHandler && options.mcpToken) {
    app.route({
      method: ["GET", "POST", "DELETE"],
      url: "/mcp",
      handler: async (request, reply) => {
        if (!hasBearerToken(request.headers.authorization, options.mcpToken!)) {
          return reply
            .header("www-authenticate", 'Bearer realm="MissionGo MCP"')
            .status(401)
            .send({
              type: "urn:missiongo:problem:authentication_required",
              title: "A valid MCP bearer token is required.",
              status: 401,
              code: "authentication_required",
            });
        }

        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers)) {
          if (value === undefined || name === "content-length" || name === "host") continue;
          headers.set(name, Array.isArray(value) ? value.join(", ") : String(value));
        }
        const method = request.method.toUpperCase();
        const webRequest = new Request(`http://missiongo.local${request.raw.url}`, {
          method,
          headers,
          ...(method === "POST" ? { body: JSON.stringify(request.body) } : {}),
        });
        const response = await mcpHandler.fetch(webRequest, { parsedBody: request.body });
        reply.status(response.status);
        response.headers.forEach((value, name) => reply.header(name, value));
        if (response.body === null) return reply.send();
        return reply.send(Buffer.from(await response.arrayBuffer()));
      },
    });
  }

  app.get("/api/v1/products", async () => store.listProducts());

  app.post("/api/v1/products", async (request, reply) => {
    const body = objectBody(request.body);
    const product = store.createProduct({
      name: stringField(body, "name")!,
      keyPrefix: stringField(body, "keyPrefix")!,
    });
    return reply.status(201).send(product);
  });

  app.patch("/api/v1/products/:productId", async (request) => {
    const { productId } = request.params as { productId: string };
    const body = objectBody(request.body);
    return store.updateProduct(productId, { name: stringField(body, "name")! });
  });

  app.get("/api/v1/products/:productId/components", async (request) => {
    const { productId } = request.params as { productId: string };
    return store.listComponents(productId);
  });

  app.post("/api/v1/products/:productId/components", async (request, reply) => {
    const { productId } = request.params as { productId: string };
    const body = objectBody(request.body);
    const component = store.createComponent({
      productId,
      name: stringField(body, "name")!,
      kind: enumField(body, "kind", COMPONENT_KINDS)! as ComponentKind,
    });
    return reply.status(201).send(component);
  });

  app.patch("/api/v1/products/:productId/components/:componentId", async (request) => {
    const { productId, componentId } = request.params as { productId: string; componentId: string };
    const body = objectBody(request.body);
    return store.updateComponent(productId, componentId, {
      name: stringField(body, "name")!,
      kind: enumField(body, "kind", COMPONENT_KINDS)! as ComponentKind,
    });
  });

  app.get("/api/v1/items", async (request) => {
    const query = request.query as Record<string, unknown>;
    const productId = typeof query.productId === "string" ? query.productId : undefined;
    if (!productId) throw invalidInput("productId is required.");
    const limit = typeof query.limit === "string" ? Number(query.limit) : undefined;
    const beforeSequence = typeof query.beforeSequence === "string" ? Number(query.beforeSequence) : undefined;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
      throw invalidInput("limit must be an integer between 1 and 100.");
    }
    if (beforeSequence !== undefined && (!Number.isInteger(beforeSequence) || beforeSequence < 1)) {
      throw invalidInput("beforeSequence must be a positive integer.");
    }

    const items = store.listWorkItems({
      productId,
      ...(typeof query.status === "string" ? { status: query.status as never } : {}),
      ...(typeof query.type === "string" ? { type: query.type as never } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(beforeSequence !== undefined ? { beforeSequence } : {}),
    });
    return { items };
  });

  app.post("/api/v1/items", async (request, reply) => {
    const body = objectBody(request.body);
    const environment = environmentBody(body.environment);
    if (!environment) throw invalidInput("environment.platform is required.");
    const item = store.createWorkItem({
      productId: stringField(body, "productId")!,
      ...(stringField(body, "sourceComponentId", false) ? { sourceComponentId: body.sourceComponentId as string } : {}),
      ...(stringArrayField(body, "affectedComponentIds")
        ? { affectedComponentIds: stringArrayField(body, "affectedComponentIds")! }
        : {}),
      ...(stringField(body, "areaId", false) ? { areaId: body.areaId as string } : {}),
      type: enumField(body, "type", WORK_ITEM_TYPES)!,
      priority: enumField(body, "priority", WORK_ITEM_PRIORITIES)!,
      title: stringField(body, "title")!,
      description: stringField(body, "description")!,
      environment,
    });
    return reply.status(201).send(item);
  });

  app.get("/api/v1/items/:itemKey", async (request) => {
    const { itemKey } = request.params as { itemKey: string };
    return store.getWorkItem(itemKey);
  });

  app.patch("/api/v1/items/:itemKey", async (request) => {
    const { itemKey } = request.params as { itemKey: string };
    const body = objectBody(request.body);
    return store.updateWorkItem(itemKey, {
      ...(stringField(body, "title", false) !== undefined ? { title: body.title as string } : {}),
      ...(stringField(body, "description", false) !== undefined ? { description: body.description as string } : {}),
      ...(body.type !== undefined ? { type: enumField(body, "type", WORK_ITEM_TYPES)! } : {}),
      ...(body.priority !== undefined ? { priority: enumField(body, "priority", WORK_ITEM_PRIORITIES)! } : {}),
      ...(body.sourceComponentId !== undefined
        ? { sourceComponentId: body.sourceComponentId === null ? null : stringField(body, "sourceComponentId", false)! }
        : {}),
      ...(body.environment !== undefined ? { environment: environmentBody(body.environment, true)! } : {}),
      ...(body.affectedComponentIds !== undefined
        ? { affectedComponentIds: stringArrayField(body, "affectedComponentIds")! }
        : {}),
    });
  });

  app.post("/api/v1/items/:itemKey/transitions", async (request) => {
    const { itemKey } = request.params as { itemKey: string };
    const body = objectBody(request.body);
    return store.transitionWorkItem({
      itemKey,
      to: enumField(body, "to", WORK_ITEM_STATUSES)!,
      actor: "human",
      reason: enumField(body, "reason", TRANSITION_REASONS)!,
      ...(stringField(body, "note", false) !== undefined ? { note: body.note as string } : {}),
    });
  });

  app.get("/api/v1/items/:itemKey/timeline", async (request) => {
    const { itemKey } = request.params as { itemKey: string };
    return { events: store.getTimeline(itemKey) };
  });

  app.post("/api/v1/items/:itemKey/attachments", async (request, reply) => {
    const { itemKey } = request.params as { itemKey: string };
    if (!Buffer.isBuffer(request.body)) throw invalidInput("Attachment body must be binary data.");
    const filename = headerText(request.headers["x-missiongo-filename"], "X-MissionGo-Filename");
    const contentType = headerText(request.headers["x-missiongo-content-type"], "X-MissionGo-Content-Type");
    const attachment = await attachmentStorage.save(store, itemKey, filename, contentType, request.body);
    return reply.status(201).send(publicAttachment(attachment));
  });

  app.get("/api/v1/items/:itemKey/attachments", async (request) => {
    const { itemKey } = request.params as { itemKey: string };
    return { attachments: store.listAttachments(itemKey).map(publicAttachment) };
  });

  app.get("/api/v1/items/:itemKey/attachments/:attachmentId/content", async (request, reply) => {
    const { itemKey, attachmentId } = request.params as { itemKey: string; attachmentId: string };
    const attachment = store.getAttachmentRecord(itemKey, attachmentId);
    const path = attachmentStorage.resolveStoredFile(attachment.storageFilename);
    const details = await stat(path);
    const disposition = attachment.kind === "log" ? "attachment" : "inline";
    const encodedFilename = encodeURIComponent(attachment.filename).replaceAll("'", "%27");
    reply
      .type(attachment.contentType)
      .header("content-length", details.size)
      .header("content-disposition", `${disposition}; filename*=UTF-8''${encodedFilename}`)
      .header("cache-control", "private, no-store")
      .header("x-content-type-options", "nosniff");
    return reply.send(createReadStream(path));
  });

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    missionGoStore: MissionGoStore;
  }
}
