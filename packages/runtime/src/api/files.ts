/** File system APIs: `wx.getFileSystemManager`, saved files and temporary files. */
import { ApiError, asyncApi, type Options } from "./common.ts";
import type { ApiContext, FsHost, TempFiles } from "./context.ts";
import type { StatsData } from "./memory-fs.ts";

export function createTempFiles(fs: FsHost): TempFiles {
  const stat = (path: string) => {
    try {
      return fs.call("stat", { path }).value as StatsData;
    } catch {
      return undefined;
    }
  };
  return {
    writeTemp: (data, extension) => fs.call("writeTemp", { extension }, data).value as string,
    read: (path) => {
      try {
        return fs.call("readFile", { path }).data;
      } catch {
        return undefined;
      }
    },
    size: (path) => {
      const stats = stat(path);
      return stats && !stats.directory ? stats.size : undefined;
    },
  };
}

/** The `Stats` object of `FileSystemManager.stat`. */
class Stats {
  mode: number;
  size: number;
  lastAccessedTime: number;
  lastModifiedTime: number;
  readonly #directory: boolean;
  constructor(data: StatsData) {
    this.mode = data.mode;
    this.size = data.size;
    this.lastAccessedTime = data.lastAccessedTime;
    this.lastModifiedTime = data.lastModifiedTime;
    this.#directory = data.directory;
  }
  isDirectory() {
    return this.#directory;
  }
  isFile() {
    return !this.#directory;
  }
}

const ENCODING_ERROR = () => new ApiError("base64 encode error", 1300203);
const invalidEncoding = () => new ApiError("Invalid argument", 1300022);

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** The bytes of string or binary data, as `writeFile` encodes them. */
export function encodeData(data: unknown, encoding = "utf8"): Uint8Array<ArrayBuffer> {
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  if (ArrayBuffer.isView(data)) {
    // Copies, so later changes to the caller's buffer do not reach the file
    return new Uint8Array(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  if (data === undefined || data === null) throw new ApiError("data to write is empty", 1301002);
  const text = String(data as string);
  switch (encoding.toLowerCase()) {
    case "utf8":
    case "utf-8":
      return new TextEncoder().encode(text);
    case "base64": {
      const clean = text.replace(/\s+/g, "");
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 === 1) throw ENCODING_ERROR();
      return base64ToBytes(clean.replace(/=+$/, "").padEnd(Math.ceil(clean.length / 4) * 4, "="));
    }
    case "hex": {
      const pairs = text.match(/^(?:[0-9a-fA-F]{2})*/)![0];
      return Uint8Array.from({ length: pairs.length / 2 }, (_, i) =>
        Number.parseInt(pairs.slice(i * 2, i * 2 + 2), 16),
      );
    }
    case "binary":
    case "latin1":
    case "ascii":
      return Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff);
    case "ucs2":
    case "ucs-2":
    case "utf16le":
    case "utf-16le": {
      const bytes = new Uint8Array(text.length * 2);
      const view = new DataView(bytes.buffer);
      for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), true);
      return bytes;
    }
    default:
      throw invalidEncoding();
  }
}

/** File bytes as `readFile` returns them: an ArrayBuffer without an encoding, otherwise a string. */
export function decodeData(bytes: Uint8Array, encoding?: string): string | ArrayBuffer {
  if (encoding === undefined || encoding === null || encoding === "") {
    return bytes.slice().buffer;
  }
  switch (String(encoding).toLowerCase()) {
    case "utf8":
    case "utf-8":
      return new TextDecoder().decode(bytes);
    case "base64":
      return bytesToBase64(bytes);
    case "hex":
      return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    case "binary":
    case "latin1":
      return Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
    case "ascii":
      return Array.from(bytes, (byte) => String.fromCharCode(byte & 0x7f)).join("");
    case "ucs2":
    case "ucs-2":
    case "utf16le":
    case "utf-16le": {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let text = "";
      for (let i = 0; i + 1 < bytes.length; i += 2)
        text += String.fromCharCode(view.getUint16(i, true));
      return text;
    }
    default:
      throw invalidEncoding();
  }
}

/** The MD5 digest of bytes as hex (RFC 1321); Web Crypto has no MD5. */
function md5(bytes: Uint8Array): string {
  const shifts = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const constants = Array.from(
    { length: 64 },
    (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0,
  );
  const padded = new Uint8Array((((bytes.length + 8) >> 6) + 1) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, (bytes.length * 8) >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(bytes.length / 2 ** 29), true);
  const state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  for (let offset = 0; offset < padded.length; offset += 64) {
    let [a, b, c, d] = state as [number, number, number, number];
    for (let i = 0; i < 64; i++) {
      const round = i >> 4;
      const f =
        round === 0
          ? (b & c) | (~b & d)
          : round === 1
            ? (d & b) | (~d & c)
            : round === 2
              ? b ^ c ^ d
              : c ^ (b | ~d);
      const g = [i, (5 * i + 1) % 16, (3 * i + 5) % 16, (7 * i) % 16][round]!;
      const shift = shifts[round * 4 + (i % 4)]!;
      const sum = (a + f + constants[i]! + view.getUint32(offset + g * 4, true)) | 0;
      a = d;
      d = c;
      c = b;
      b = (b + ((sum << shift) | (sum >>> (32 - shift)))) | 0;
    }
    state[0] = (state[0]! + a) | 0;
    state[1] = (state[1]! + b) | 0;
    state[2] = (state[2]! + c) | 0;
    state[3] = (state[3]! + d) | 0;
  }
  const out = new DataView(new ArrayBuffer(16));
  state.forEach((word, i) => out.setUint32(i * 4, word, true));
  return Array.from(new Uint8Array(out.buffer), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

async function digest(bytes: Uint8Array<ArrayBuffer>, algorithm = "md5"): Promise<string> {
  const name = String(algorithm).toLowerCase();
  if (name === "md5") return md5(bytes);
  const subtle = { sha1: "SHA-1", sha256: "SHA-256" }[name];
  if (!subtle) throw new ApiError("Invalid argument", 1300022);
  const hash = new Uint8Array(await crypto.subtle.digest(subtle, bytes));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createFileApis(ctx: ApiContext): Record<string, unknown> {
  const fs = ctx.host.fs;
  const call = (op: string, args: Record<string, unknown>, data?: Uint8Array) =>
    fs.call(op, args, data);
  const statsOf = (value: unknown) =>
    Array.isArray(value)
      ? (value as { path: string; stats: StatsData }[]).map((entry) => ({
          path: entry.path,
          stats: new Stats(entry.stats),
        }))
      : new Stats(value as StatsData);
  const fileInfo = async (options: Options) => {
    const data = call("readFile", { path: String(options.filePath ?? "") }).data!;
    return {
      size: data.length,
      digest: await digest(data as Uint8Array<ArrayBuffer>, options.digestAlgorithm),
    };
  };

  // Each operation takes the options object of its async form and returns its success result
  const operations: Record<string, (options: Options) => Record<string, unknown>> = {
    access: (o) => (call("access", { path: o.path }), {}),
    appendFile: (o) => (
      call("writeFile", { path: o.filePath, append: true }, encodeData(o.data, o.encoding)),
      {}
    ),
    copyFile: (o) => (call("copyFile", { srcPath: o.srcPath, destPath: o.destPath }), {}),
    mkdir: (o) => (call("mkdir", { path: o.dirPath, recursive: o.recursive }), {}),
    readdir: (o) => ({ files: call("readdir", { path: o.dirPath }).value }),
    readFile: (o) => ({
      data: decodeData(
        call("readFile", { path: o.filePath, position: o.position, length: o.length }).data!,
        o.encoding,
      ),
    }),
    rename: (o) => (call("rename", { oldPath: o.oldPath, newPath: o.newPath }), {}),
    rmdir: (o) => (call("rmdir", { path: o.dirPath, recursive: o.recursive }), {}),
    saveFile: (o) => ({
      savedFilePath: call("saveFile", { tempFilePath: o.tempFilePath, filePath: o.filePath }).value,
    }),
    stat: (o) => ({ stats: statsOf(call("stat", { path: o.path, recursive: o.recursive }).value) }),
    truncate: (o) => (call("truncate", { path: o.filePath, length: o.length }), {}),
    unlink: (o) => (call("unlink", { path: o.filePath }), {}),
    writeFile: (o) => (call("writeFile", { path: o.filePath }, encodeData(o.data, o.encoding)), {}),
    open: (o) => ({ fd: call("open", { path: o.filePath, flag: o.flag ?? "r" }).value }),
    close: (o) => (call("close", { fd: o.fd }), {}),
    fstat: (o) => ({ stats: statsOf(call("fstat", { fd: o.fd }).value) }),
    ftruncate: (o) => (call("ftruncate", { fd: o.fd, length: o.length }), {}),
    read: (o) => {
      const buffer = o.arrayBuffer;
      if (!(buffer instanceof ArrayBuffer))
        throw new ApiError("array buffer does not exist", 1302005);
      const offset = Number(o.offset ?? 0);
      const length = Number(o.length ?? 0);
      if (!Number.isInteger(offset) || offset < 0 || offset > buffer.byteLength) {
        throw new ApiError("value of offset is out of range", 1301007);
      }
      if (!Number.isInteger(length) || length < 0 || offset + length > buffer.byteLength) {
        throw new ApiError("value of length is out of range", 1301006);
      }
      const chunk = call("read", { fd: o.fd, length, position: o.position ?? undefined }).data!;
      new Uint8Array(buffer, offset, chunk.length).set(chunk);
      return { bytesRead: chunk.length, arrayBuffer: buffer };
    },
    write: (o) => {
      let bytes = encodeData(o.data, o.encoding);
      if (typeof o.data !== "string") {
        const offset = Number(o.offset ?? 0);
        if (!Number.isInteger(offset) || offset < 0 || offset > bytes.length) {
          throw new ApiError("value of offset is out of range", 1301007);
        }
        const length = o.length === undefined ? bytes.length - offset : Number(o.length);
        if (!Number.isInteger(length) || length < 0 || offset + length > bytes.length) {
          throw new ApiError("value of length is out of range", 1301006);
        }
        bytes = bytes.slice(offset, offset + length);
      }
      const position = typeof o.position === "number" ? o.position : undefined;
      return { bytesWritten: call("write", { fd: o.fd, position }, bytes).value };
    },
  };

  // How each *Sync method maps its arguments to the options of the async form, and what it returns
  const syncForms: Record<
    string,
    [(...args: any[]) => Options, (result: Record<string, unknown>) => unknown]
  > = {
    access: [(path) => ({ path }), () => undefined],
    appendFile: [(filePath, data, encoding) => ({ filePath, data, encoding }), () => undefined],
    copyFile: [(srcPath, destPath) => ({ srcPath, destPath }), () => undefined],
    mkdir: [(dirPath, recursive) => ({ dirPath, recursive }), () => undefined],
    readdir: [(dirPath) => ({ dirPath }), (result) => result.files],
    readFile: [
      (filePath, encoding, position, length) => ({ filePath, encoding, position, length }),
      (result) => result.data,
    ],
    rename: [(oldPath, newPath) => ({ oldPath, newPath }), () => undefined],
    rmdir: [(dirPath, recursive) => ({ dirPath, recursive }), () => undefined],
    saveFile: [
      (tempFilePath, filePath) => ({ tempFilePath, filePath }),
      (result) => result.savedFilePath,
    ],
    stat: [(path, recursive) => ({ path, recursive }), (result) => result.stats],
    truncate: [(options: Options) => options, () => undefined],
    unlink: [(filePath) => ({ filePath }), () => undefined],
    writeFile: [(filePath, data, encoding) => ({ filePath, data, encoding }), () => undefined],
    open: [(options: Options) => options, (result) => result.fd],
    close: [(options: Options) => options, () => undefined],
    fstat: [(options: Options) => options, (result) => result.stats],
    ftruncate: [(options: Options) => options, () => undefined],
    read: [(options: Options) => options, (result) => result],
    write: [(options: Options) => options, (result) => result],
  };

  const manager: Record<string, unknown> = {
    getFileInfo: asyncApi("getFileInfo", fileInfo, { promise: false }),
    getSavedFileList: asyncApi(
      "getSavedFileList",
      async () => ({ fileList: call("savedFiles", {}).value }),
      { promise: false },
    ),
    removeSavedFile: asyncApi(
      "removeSavedFile",
      async (o) => (call("removeSavedFile", { filePath: o.filePath }), {}),
      { promise: false },
    ),
  };
  for (const [name, operation] of Object.entries(operations)) {
    // FileSystemManager's async methods take callbacks only, without Promises
    manager[name] = asyncApi(name, async (options) => operation(options), { promise: false });
    const [toOptions, toResult] = syncForms[name]!;
    manager[`${name}Sync`] = (...args: unknown[]) => {
      try {
        return toResult(operation(toOptions(...args)));
      } catch (error) {
        const errno = (error as { errno?: number }).errno;
        throw new ApiError(`${name}Sync:fail ${(error as Error).message}`, errno);
      }
    };
  }

  const savedFileInfo = (filePath: string) => {
    const files = call("savedFiles", {}).value as {
      filePath: string;
      size: number;
      createTime: number;
    }[];
    const file = files.find((entry) => entry.filePath === filePath);
    if (!file) throw new ApiError(`no such file or directory ${filePath}`, 1300002);
    return { size: file.size, createTime: file.createTime };
  };

  return {
    getFileSystemManager: () => manager,
    saveFile: asyncApi("saveFile", async (options) => ({
      savedFilePath: call("saveFile", {
        tempFilePath: options.tempFilePath,
        filePath: options.filePath,
      }).value,
    })),
    getSavedFileList: asyncApi("getSavedFileList", async () => ({
      fileList: call("savedFiles", {}).value,
    })),
    getSavedFileInfo: asyncApi("getSavedFileInfo", async (options) =>
      savedFileInfo(String(options.filePath ?? "")),
    ),
    removeSavedFile: asyncApi("removeSavedFile", async (options) => {
      call("removeSavedFile", { filePath: options.filePath });
      return {};
    }),
    getFileInfo: asyncApi("getFileInfo", fileInfo),
    // The simulator has no document viewer; opening succeeds once the file exists
    openDocument: asyncApi("openDocument", async (options) => {
      call("access", { path: options.filePath });
      return {};
    }),
  };
}
