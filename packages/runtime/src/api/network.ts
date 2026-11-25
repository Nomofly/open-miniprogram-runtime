/** Network APIs: `wx.request`, uploads, downloads and WebSockets. */
import {
  ApiError,
  asyncApi,
  hasTapGesture,
  respond,
  safeCall,
  type AnyFunction,
  type Options,
} from "./common.ts";
import type { ApiContext } from "./context.ts";
import { base64ToBytes, bytesToBase64 } from "./files.ts";

/** The simulator endpoint that performs `wx.request` for the logic layer, avoiding CORS. */
export const REQUEST_PROXY_PATH = "/__omr/request";
/** The response header of a streamed proxy response that carries its status and headers as URI-encoded JSON. */
export const PROXY_HEAD_HEADER = "x-omr-proxy";

/** A request for the proxy; `stream` asks for the body as is, with the head in `PROXY_HEAD_HEADER`. */
export interface ProxyRequest {
  url: string;
  method: string;
  header: Record<string, string>;
  body?: string;
  /** "base64" when `body` holds binary data. */
  bodyEncoding?: "base64";
  /** "arraybuffer" to get the response body as base64. */
  responseType?: "arraybuffer";
  stream?: boolean;
}

export interface ProxyHead {
  statusCode: number;
  header: Record<string, string>;
  cookies?: string[];
  error?: string;
}

export interface ProxyResponse extends ProxyHead {
  body?: string;
  bodyEncoding?: "base64";
}

const DEFAULT_TIMEOUT = 60_000;
const TIMEOUT = "timeout";
const ABORT = "abort";
/** The errno of an API timeout. */
const TIMEOUT_ERRNO = 5;
/** The errno of a network error from the HTTP stack. */
const NETWORK_ERRNO = 600001;
const LOCAL_IP = { localip: "192.168.1.100", netmask: "255.255.255.0" };

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "application/json": "json",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/html": "html",
  "audio/mpeg": "mp3",
  "video/mp4": "mp4",
};
const CONTENT_TYPES: Record<string, string> = Object.fromEntries(
  Object.entries(EXTENSIONS).map(([type, extension]) => [extension, type]),
);
CONTENT_TYPES.jpeg = "image/jpeg";

/** Listeners of one task event, such as `onProgressUpdate`. */
function listeners() {
  const set = new Set<AnyFunction>();
  return {
    on: (listener: AnyFunction) => {
      if (typeof listener === "function") set.add(listener);
    },
    off: (listener?: AnyFunction) => {
      if (listener) set.delete(listener);
      else set.clear();
    },
    emit: (value: unknown) => set.forEach((listener) => safeCall(listener, value)),
  };
}

const headerValue = (header: Record<string, string>, name: string) =>
  Object.entries(header).find(([key]) => key.toLowerCase() === name)?.[1];

function concat(chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function toBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return undefined;
}

function requireHttpUrl(url: string) {
  if (!/^https?:\/\//i.test(url)) throw new ApiError("invalid url");
}

async function proxy(request: ProxyRequest, signal: AbortSignal): Promise<ProxyResponse> {
  const response = await fetch(REQUEST_PROXY_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });
  const result = (await response.json()) as ProxyResponse;
  if (result.error) throw new Error(result.error);
  return result;
}

/** Sends a request through the proxy and reads its body as it arrives; canvas images load with it too. */
export async function proxyStream(
  request: ProxyRequest,
  signal: AbortSignal,
  onHead: (head: ProxyHead) => void,
  onChunk: (chunk: Uint8Array, received: number) => void,
): Promise<{ head: ProxyHead; bytes: Uint8Array<ArrayBuffer> }> {
  const response = await fetch(REQUEST_PROXY_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...request, stream: true }),
    signal,
  });
  const encoded = response.headers.get(PROXY_HEAD_HEADER);
  const head = encoded
    ? (JSON.parse(decodeURIComponent(encoded)) as ProxyHead)
    : { ...((await response.json()) as ProxyHead), statusCode: 0, header: {} };
  if (head.error) throw new Error(head.error);
  onHead(head);
  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = response.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onChunk(value, received);
  }
  return { head, bytes: concat(chunks) };
}

/** A running network task: its abort signal, with the timeout armed. */
function startJob(timeout: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(TIMEOUT), timeout);
  return {
    signal: controller.signal,
    abort: () => {
      if (!controller.signal.aborted) controller.abort(ABORT);
    },
    done: () => clearTimeout(timer),
  };
}

/** The fail result of a network task, by why it failed. */
function failure(name: string, error: unknown, signal: AbortSignal) {
  if (signal.aborted) {
    return signal.reason === TIMEOUT
      ? { errMsg: `${name}:fail timeout`, errno: TIMEOUT_ERRNO }
      : { errMsg: `${name}:fail abort` };
  }
  if (error instanceof ApiError) {
    return {
      errMsg: `${name}:fail ${error.message}`,
      ...(error.errno ? { errno: error.errno } : {}),
    };
  }
  return { errMsg: `${name}:fail ${(error as Error).message ?? error}`, errno: NETWORK_ERRNO };
}

const head = (result: ProxyHead) => ({
  header: result.header ?? {},
  statusCode: result.statusCode,
  cookies: result.cookies ?? [],
});

export function createNetworkApis(ctx: ApiContext): Record<string, unknown> {
  const networkTimeout = (ctx.host.manifest.appJson.networkTimeout ?? {}) as Record<
    string,
    unknown
  >;
  const timeoutOf = (kind: string, options: Options) => {
    const value = Number(options.timeout ?? networkTimeout[kind] ?? DEFAULT_TIMEOUT);
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT;
  };

  /** Runs a task and calls its callbacks with `${name}:ok` or the failure. */
  const runTask = (
    name: string,
    options: Options,
    job: ReturnType<typeof startJob>,
    run: () => Promise<Record<string, unknown>>,
    tapped = false,
  ) => {
    void Promise.resolve()
      .then(run)
      .then(
        (result) => {
          job.done();
          respond([options.success, options.complete], { ...result, errMsg: `${name}:ok` }, tapped);
        },
        (error: unknown) => {
          job.done();
          respond([options.fail, options.complete], failure(name, error, job.signal), tapped);
        },
      );
  };

  const request = (options: Options = {}) => {
    // Callbacks keep the tap state of the call
    const tapped = hasTapGesture();
    const job = startJob(timeoutOf("request", options));
    const headers = listeners();
    const chunks = listeners();
    runTask(
      "request",
      options,
      job,
      () => performRequest(options, job.signal, headers.emit, chunks.emit),
      tapped,
    );
    return {
      abort: job.abort,
      onHeadersReceived: headers.on,
      offHeadersReceived: headers.off,
      onChunkReceived: chunks.on,
      offChunkReceived: chunks.off,
    };
  };

  const downloadFile = (options: Options = {}) => {
    const job = startJob(timeoutOf("downloadFile", options));
    const headers = listeners();
    const progress = listeners();
    runTask("downloadFile", options, job, async () => {
      const url = String(options.url ?? "");
      requireHttpUrl(url);
      let total = 0;
      const { head: response, bytes } = await proxyStream(
        { url, method: "GET", header: { ...options.header } },
        job.signal,
        (result) => {
          total = Number(headerValue(result.header ?? {}, "content-length") ?? 0) || 0;
          headers.emit(head(result));
        },
        (_chunk, received) =>
          progress.emit({
            progress: total ? Math.min(100, Math.floor((received / total) * 100)) : 0,
            totalBytesWritten: received,
            totalBytesExpectedToWrite: total || received,
          }),
      );
      if (bytes.length === 0 || !total || bytes.length < total) {
        progress.emit({
          progress: 100,
          totalBytesWritten: bytes.length,
          totalBytesExpectedToWrite: bytes.length,
        });
      }
      if (options.filePath !== undefined && options.filePath !== "") {
        const filePath = String(options.filePath);
        ctx.host.fs.call("writeFile", { path: filePath }, bytes);
        return { filePath, statusCode: response.statusCode };
      }
      const urlExtension = /\.([a-z0-9]{1,8})$/i.exec(new URL(url).pathname)?.[1];
      const type = headerValue(response.header ?? {}, "content-type")
        ?.split(";")[0]
        ?.trim();
      const extension = urlExtension ?? (type && EXTENSIONS[type.toLowerCase()]) ?? "";
      return {
        tempFilePath: ctx.files.writeTemp(bytes, extension),
        statusCode: response.statusCode,
      };
    });
    return {
      abort: job.abort,
      onProgressUpdate: progress.on,
      offProgressUpdate: progress.off,
      onHeadersReceived: headers.on,
      offHeadersReceived: headers.off,
    };
  };

  const uploadFile = (options: Options = {}) => {
    const job = startJob(timeoutOf("uploadFile", options));
    const headers = listeners();
    const progress = listeners();
    runTask("uploadFile", options, job, async () => {
      const url = String(options.url ?? "");
      requireHttpUrl(url);
      const filePath = String(options.filePath ?? "");
      const file = ctx.host.fs.call("readFile", { path: filePath }).data ?? new Uint8Array();
      const boundary = `----OmrFormBoundary${Math.random().toString(36).slice(2, 14)}`;
      const encoder = new TextEncoder();
      const quote = (value: string) => value.replace(/"/g, "%22").replace(/\r?\n/g, " ");
      const parts: Uint8Array[] = [];
      for (const [key, value] of Object.entries(
        (options.formData ?? {}) as Record<string, unknown>,
      )) {
        const text =
          typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
        parts.push(
          encoder.encode(
            `--${boundary}\r\nContent-Disposition: form-data; name="${quote(key)}"\r\n\r\n${text}\r\n`,
          ),
        );
      }
      const filename = filePath.slice(filePath.lastIndexOf("/") + 1);
      const extension = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase() ?? "";
      parts.push(
        encoder.encode(
          `--${boundary}\r\nContent-Disposition: form-data; name="${quote(String(options.name ?? ""))}"; filename="${quote(filename)}"\r\nContent-Type: ${CONTENT_TYPES[extension] ?? "application/octet-stream"}\r\n\r\n`,
        ),
        file,
        encoder.encode(`\r\n--${boundary}--\r\n`),
      );
      const body = concat(parts);
      const header: Record<string, string> = Object.fromEntries(
        Object.entries((options.header ?? {}) as Record<string, unknown>)
          .filter(([key]) => key.toLowerCase() !== "content-type")
          .map(([key, value]) => [key, String(value)]),
      );
      header["content-type"] = `multipart/form-data; boundary=${boundary}`;
      const result = await proxy(
        { url, method: "POST", header, body: bytesToBase64(body), bodyEncoding: "base64" },
        job.signal,
      );
      progress.emit({
        progress: 100,
        totalBytesSent: body.length,
        totalBytesExpectedToSend: body.length,
      });
      headers.emit(head(result));
      return { data: result.body ?? "", statusCode: result.statusCode };
    });
    return {
      abort: job.abort,
      onProgressUpdate: progress.on,
      offProgressUpdate: progress.off,
      onHeadersReceived: headers.on,
      offHeadersReceived: headers.off,
    };
  };

  // The wx.onSocket* and wx.*Socket* APIs act on the latest connection, as before SocketTask existed
  let latestSocket: ReturnType<typeof createSocketTask> | undefined;
  const globalSocketListeners: Record<string, AnyFunction | undefined> = {};

  const createSocketTask = (options: Options) => {
    const events = {
      open: listeners(),
      close: listeners(),
      error: listeners(),
      message: listeners(),
    };
    let socket: WebSocket | undefined;
    const emit = (event: keyof typeof events, value: unknown) => {
      events[event].emit(value);
      if (latestSocket === task) safeCall(globalSocketListeners[event], value);
    };
    const send = (sendOptions: Options) => {
      if (socket?.readyState !== 1) throw new ApiError("WebSocket is not connected");
      const data = sendOptions.data;
      socket.send(typeof data === "string" ? data : ((toBytes(data) ?? String(data)) as never));
      return {};
    };
    const close = (closeOptions: Options) => {
      if (!socket) throw new ApiError("WebSocket is not connected");
      socket.close(
        closeOptions.code === undefined ? 1000 : Number(closeOptions.code),
        closeOptions.reason === undefined ? undefined : String(closeOptions.reason),
      );
      return {};
    };
    const task = {
      send: asyncApi("sendSocketMessage", async (o) => send(o), { promise: false }),
      close: asyncApi("closeSocket", async (o) => close(o), { promise: false }),
      onOpen: events.open.on,
      offOpen: events.open.off,
      onClose: events.close.on,
      offClose: events.close.off,
      onError: events.error.on,
      offError: events.error.off,
      onMessage: events.message.on,
      offMessage: events.message.off,
      sendRaw: send,
      closeRaw: close,
    };
    const callbacks = (result: Record<string, unknown>, ok: boolean) =>
      respond(
        ok ? [options.success, options.complete] : [options.fail, options.complete],
        result,
        false,
      );
    const url = String(options.url ?? "");
    try {
      if (!/^wss?:\/\//i.test(url)) throw new Error(`invalid url "${url}"`);
      const protocols = Array.isArray(options.protocols)
        ? options.protocols.map(String)
        : undefined;
      // Browsers cannot set WebSocket request headers, so options.header is not sent
      socket = new WebSocket(url, protocols);
    } catch (error) {
      queueMicrotask(() =>
        callbacks({ errMsg: `connectSocket:fail ${(error as Error).message}` }, false),
      );
      return task;
    }
    socket.binaryType = "arraybuffer";
    const timeout = options.timeout ?? networkTimeout.connectSocket;
    const timer =
      timeout === undefined
        ? undefined
        : setTimeout(() => {
            if (socket?.readyState !== 0) return;
            emit("error", { errMsg: "connectSocket:fail timeout" });
            socket.close();
          }, Number(timeout));
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      emit("open", { header: {}, profile: {} });
    });
    socket.addEventListener("message", (event: MessageEvent) =>
      emit("message", { data: event.data }),
    );
    socket.addEventListener("error", () =>
      emit("error", { errMsg: "WebSocket connection failed" }),
    );
    socket.addEventListener("close", (event: CloseEvent) => {
      clearTimeout(timer);
      emit("close", { code: event.code, reason: event.reason });
    });
    queueMicrotask(() => callbacks({ errMsg: "connectSocket:ok" }, true));
    return task;
  };

  const publicTask = (task: ReturnType<typeof createSocketTask>) => {
    const { sendRaw: _send, closeRaw: _close, ...rest } = task;
    return rest;
  };

  const statusListeners = listeners();
  const weakListeners = listeners();

  return {
    request,
    downloadFile,
    uploadFile,
    connectSocket: (options: Options = {}) => {
      const task = createSocketTask(options);
      latestSocket = task;
      return publicTask(task);
    },
    onSocketOpen: (listener: AnyFunction) => (globalSocketListeners.open = listener),
    onSocketClose: (listener: AnyFunction) => (globalSocketListeners.close = listener),
    onSocketError: (listener: AnyFunction) => (globalSocketListeners.error = listener),
    onSocketMessage: (listener: AnyFunction) => (globalSocketListeners.message = listener),
    sendSocketMessage: asyncApi("sendSocketMessage", async (options) => {
      if (!latestSocket) throw new ApiError("WebSocket is not connected");
      return latestSocket.sendRaw(options);
    }),
    closeSocket: asyncApi("closeSocket", async (options) => {
      if (!latestSocket) throw new ApiError("WebSocket is not connected");
      return latestSocket.closeRaw(options);
    }),
    // The simulated network never changes
    onNetworkStatusChange: statusListeners.on,
    offNetworkStatusChange: statusListeners.off,
    onNetworkWeakChange: weakListeners.on,
    offNetworkWeakChange: weakListeners.off,
    getLocalIPAddress: asyncApi("getLocalIPAddress", async () => ({ ...LOCAL_IP })),
  };
}

async function performRequest(
  options: Options,
  signal: AbortSignal,
  onHeaders: (value: unknown) => void,
  onChunk: (value: unknown) => void,
) {
  const url = String(options.url ?? "");
  requireHttpUrl(url);
  const method = String(options.method ?? "GET").toUpperCase();
  const header: Record<string, string> = { ...options.header };
  const contentTypeKey = Object.keys(header).find((key) => key.toLowerCase() === "content-type");
  if (!contentTypeKey) header["content-type"] = "application/json";
  const contentType = header[contentTypeKey ?? "content-type"]!;
  let target = url;
  let body: string | undefined;
  let bodyEncoding: "base64" | undefined;
  const data = options.data;
  const binary = toBytes(data);
  if (method === "GET" || method === "HEAD") {
    const query =
      typeof data === "string"
        ? data
        : data && typeof data === "object" && !binary
          ? Object.entries(data as Record<string, unknown>)
              .map(
                ([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
              )
              .join("&")
          : "";
    if (query) target += (target.includes("?") ? "&" : "?") + query;
  } else if (binary) {
    body = bytesToBase64(binary);
    bodyEncoding = "base64";
  } else if (data !== undefined) {
    body =
      typeof data === "string"
        ? data
        : contentType.includes("x-www-form-urlencoded")
          ? new URLSearchParams(data as Record<string, string>).toString()
          : JSON.stringify(data);
  }
  const arraybuffer = options.responseType === "arraybuffer";
  const request: ProxyRequest = { url: target, method, header, body, bodyEncoding };
  let result: ProxyHead;
  let bytes: Uint8Array | undefined;
  let text: string | undefined;
  if (options.enableChunked) {
    ({ head: result, bytes } = await proxyStream(
      request,
      signal,
      (received) => onHeaders(head(received)),
      (chunk) => onChunk({ data: chunk.slice().buffer }),
    ));
  } else {
    const response = await proxy(
      arraybuffer ? { ...request, responseType: "arraybuffer" } : request,
      signal,
    );
    result = response;
    if (response.bodyEncoding === "base64") bytes = base64ToBytes(response.body ?? "");
    else text = response.body ?? "";
    onHeaders(head(response));
  }
  let responseData: unknown;
  if (arraybuffer) {
    responseData = (bytes ?? new TextEncoder().encode(text ?? "")).slice().buffer;
  } else {
    responseData = text ?? new TextDecoder().decode(bytes);
    if ((options.dataType ?? "json") === "json") {
      try {
        responseData = JSON.parse(responseData as string);
      } catch {
        // WeChat returns the text as is when it is not JSON
      }
    }
  }
  return { data: responseData, ...head(result) };
}
