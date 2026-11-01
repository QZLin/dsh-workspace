export const DEFAULT_MAX_REQUEST_BYTES = 64 * 1024;
export const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

export class FrameTooLargeError extends Error {
  constructor(limit) {
    super(`JSON-RPC frame exceeds ${limit} bytes`);
    this.name = 'FrameTooLargeError';
  }
}

/** Incremental byte framing: no quadratic concatenation or partial UTF-8 decode. */
export class LineFramer {
  constructor(limit = DEFAULT_MAX_REQUEST_BYTES) {
    this.limit = limit;
    this.parts = [];
    this.length = 0;
  }

  push(chunk, onLine) {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(offset, end);
      const total = this.length + part.length;
      const lastByte = part.length ? part.at(-1) : this.parts.at(-1)?.at(-1);
      // LF and one optional terminal CR are delimiters, not payload bytes.
      if (total > this.limit && !(total === this.limit + 1 && lastByte === 13)) {
        throw new FrameTooLargeError(this.limit);
      }
      if (part.length) {
        this.parts.push(part);
        this.length += part.length;
      }
      if (newline < 0) return;
      let line = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts, this.length);
      this.parts = [];
      this.length = 0;
      if (line.at(-1) === 13) line = line.subarray(0, -1);
      if (onLine(line) === false) return;
      offset = newline + 1;
    }
  }
}

const decoder = new TextDecoder('utf-8', { fatal: true });
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = (value) => value === null || typeof value === 'string'
  || (typeof value === 'number' && Number.isFinite(value));

export function parseRequest(line) {
  let request;
  try {
    request = JSON.parse(decoder.decode(line));
  } catch {
    throw new RpcError(-32700, 'Parse error: expected a UTF-8 JSON object');
  }
  const hasId = object(request) && Object.hasOwn(request, 'id');
  const id = hasId && validId(request.id) ? request.id : null;
  if (!object(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string'
    || (hasId && !validId(request.id))) {
    const error = new RpcError(-32600, 'Invalid Request: JSON-RPC 2.0 object required (no batches)');
    error.requestId = id;
    throw error;
  }
  return { ...request, notification: !hasId, id };
}

function paramsFor(request, required, optional = []) {
  const params = Object.hasOwn(request, 'params') ? request.params : {};
  if (!object(params)) throw new RpcError(-32602, 'Invalid params: expected an object');
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(params)) {
    if (!allowed.has(key)) throw new RpcError(-32602, `Invalid params: unexpected property '${key}'`);
  }
  for (const key of required) {
    if (!Object.hasOwn(params, key) || typeof params[key] !== 'string') throw new RpcError(-32602, `Invalid params: '${key}' must be a string`);
  }
  for (const key of optional) {
    if (Object.hasOwn(params, key) && typeof params[key] !== 'string') {
      throw new RpcError(-32602, `Invalid params: '${key}' must be a string when supplied`);
    }
  }
  return params;
}

export function workspaceProjection(workspace) {
  return { id: workspace.id, path: workspace.path, title: workspace.title };
}

function requireWorkspace(registry, id) {
  const workspace = registry.get(id);
  if (!workspace) throw new RpcError(-32004, `Unknown workspace '${id}'`, { id });
  return workspace;
}

/**
 * Validate wire shapes only and prepare an operation on the injected registry.
 * In particular, create and resolveByPath receive the caller's exact string.
 */
export function prepareOperation(registry, request, profile = null) {
  switch (request.method) {
    case 'workspace.add': {
      const params = paramsFor(request, ['path'], ['title']);
      return async () => workspaceProjection(await registry.create(params.path, params.title));
    }
    case 'workspace.list': {
      paramsFor(request, []);
      return () => registry.list().map(workspaceProjection);
    }
    case 'workspace.get': {
      const { id } = paramsFor(request, ['id']);
      return () => {
        const workspace = requireWorkspace(registry, id);
        return {
          ...workspaceProjection(workspace),
          createdAt: workspace.createdAt,
          updatedAt: workspace.updatedAt,
          sessionIds: [...workspace.sessionIds],
        };
      };
    }
    case 'workspace.rename': {
      const { id, title } = paramsFor(request, ['id', 'title']);
      return async () => {
        const workspace = requireWorkspace(registry, id);
        if (workspace.title !== title) await workspace.setTitle(title);
        return workspaceProjection(workspace);
      };
    }
    case 'workspace.remove': {
      const { id } = paramsFor(request, ['id']);
      return async () => ({ id, deleted: await registry.delete(id) });
    }
    case 'workspace.move': {
      const { id, beforeId } = paramsFor(request, ['id'], ['beforeId']);
      return async () => ({ order: [...await registry.insertBefore(id, beforeId)] });
    }
    case 'workspace.resolve': {
      const { path } = paramsFor(request, ['path']);
      return async () => {
        const workspace = await registry.resolveByPath(path);
        return workspace ? workspaceProjection(workspace) : null;
      };
    }
    case 'workspace.status': {
      const { id } = paramsFor(request, ['id']);
      return async () => ({ id, status: await requireWorkspace(registry, id).status() });
    }
    case 'workspace.ping': {
      paramsFor(request, []);
      return () => ({ service: 'dsh-workspace', protocolVersion: 1, profile });
    }
    default:
      throw new RpcError(-32601, `Method not found: '${request.method}'`);
  }
}

export function errorProjection(error) {
  if (error instanceof RpcError) {
    return {
      code: error.code,
      message: error.message.slice(0, 4096),
      ...(error.data !== undefined ? { data: error.data } : {}),
    };
  }
  // Domain failures remain errors, never fabricated successful workspaces.
  // No stack trace or private registry object is transmitted.
  const data = { name: typeof error?.name === 'string' ? error.name.slice(0, 128) : 'Error' };
  if (typeof error?.code === 'string') data.code = error.code.slice(0, 128);
  return {
    code: error?.name === 'WorkspaceOrderInvalidError' ? -32004 : -32001,
    message: (typeof error?.message === 'string' ? error.message : 'Workspace operation failed').slice(0, 4096),
    data,
  };
}

export function encodeResponse(id, result, error, limit = DEFAULT_MAX_RESPONSE_BYTES) {
  let response = error === undefined
    ? { jsonrpc: '2.0', id, result }
    : { jsonrpc: '2.0', id, error: errorProjection(error) };
  let line;
  try {
    line = Buffer.from(`${JSON.stringify(response)}\n`, 'utf8');
  } catch {
    response = { jsonrpc: '2.0', id, error: { code: -32603, message: 'Internal error: result is not JSON serializable' } };
    line = Buffer.from(`${JSON.stringify(response)}\n`, 'utf8');
  }
  if (line.length - 1 > limit) {
    line = Buffer.from(`${JSON.stringify({
      jsonrpc: '2.0', id, error: { code: -32005, message: `Response exceeds ${limit} bytes` },
    })}\n`, 'utf8');
  }
  return line.length - 1 <= limit ? line : null;
}
