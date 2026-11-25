/**
 * An in-memory Mini Program file system: user files under `wxfile://usr`
 * (`wx.env.USER_DATA_PATH`), temporary files `http://tmp/<name>`, saved files
 * `wxfile://store_<name>`, and read-only code package files from a fallback.
 * It implements the operations of `FileSystemManager` behind `FsHost.call`.
 */
import { ApiError } from "./common.ts";
import type { FsHost, FsResult } from "./context.ts";

/** Where the simulator serves `FsHost.call` for the logic layer. */
export const FS_RPC_PATH = "/__omr/fs";

export const USER_DATA_PATH = "wxfile://usr";
const TEMP_ROOT = "http://tmp";
const STORE_PREFIX = "wxfile://store_";
/** User files and saved files share this quota, as on WeChat. */
const STORAGE_LIMIT = 200 * 1024 * 1024;

/** The code package files of a Mini Program, by path relative to its root ("" is the root). */
export interface PackageFiles {
  stat(path: string): { directory: boolean; size: number; mtimeMs: number } | undefined;
  read(path: string): Uint8Array | undefined;
  /** The names in a directory, or undefined when it is not one. */
  list(path: string): string[] | undefined;
}

/** The data of a `Stats` object; times are UNIX timestamps in seconds, as on WeChat. */
export interface StatsData {
  mode: number;
  size: number;
  lastAccessedTime: number;
  lastModifiedTime: number;
  directory: boolean;
}

// FileSystemManager errors, as WeChat documents them
const fail = {
  notPermitted: () => new ApiError("operation not permitted", 1300001),
  notFound: (path: string) => new ApiError(`no such file or directory ${path}`, 1300002),
  badFd: () => new ApiError("bad file descriptor", 1300009),
  permission: () => new ApiError("permission denied", 1300013),
  notDirectory: () => new ApiError("not a directory", 1300020),
  invalid: () => new ApiError("Invalid argument", 1300022),
  notEmpty: () => new ApiError("directory not empty", 1300066),
  limit: () => new ApiError("the maximum size of the file storage limit is exceeded", 1300202),
  directory: () => new ApiError("illegal operation on a directory", 1301003),
  exists: (path: string) => new ApiError(`file already exists ${path}`, 1301005),
  length: () => new ApiError("value of length is out of range", 1301006),
  position: () => new ApiError("value of position is out of range", 1301009),
  tempMissing: () => new ApiError("tempFilePath file not exist", 1301112),
  fdPermission: () => new ApiError("fail permission denied", 1302001),
  flag: () => new ApiError("invalid flag", 1302003),
};

type Node =
  | { type: "file"; data: Uint8Array; mtime: number; atime: number; ctime: number }
  | { type: "dir"; mtime: number; atime: number; ctime: number };

type Area = "usr" | "tmp" | "store" | "package";
interface Location {
  area: Area;
  /** The normalized path; for the code package, relative to its root. */
  key: string;
}

interface OpenFile {
  key: string;
  readable: boolean;
  writable: boolean;
  append: boolean;
  position: number;
}

const FLAGS: Record<
  string,
  {
    read: boolean;
    write: boolean;
    create: boolean;
    truncate?: boolean;
    exclusive?: boolean;
    append?: boolean;
  }
> = {
  r: { read: true, write: false, create: false },
  "r+": { read: true, write: true, create: false },
  w: { read: false, write: true, create: true, truncate: true },
  wx: { read: false, write: true, create: true, truncate: true, exclusive: true },
  "w+": { read: true, write: true, create: true, truncate: true },
  "wx+": { read: true, write: true, create: true, truncate: true, exclusive: true },
  a: { read: false, write: true, create: true, append: true },
  ax: { read: false, write: true, create: true, append: true, exclusive: true },
  "a+": { read: true, write: true, create: true, append: true },
  "ax+": { read: true, write: true, create: true, append: true, exclusive: true },
  as: { read: false, write: true, create: true, append: true },
  "as+": { read: true, write: true, create: true, append: true },
};

const copy = (data: Uint8Array) => new Uint8Array(data);
const seconds = (ms: number) => Math.floor(ms / 1000);

export class MemoryFs implements FsHost {
  readonly #nodes = new Map<string, Node>();
  readonly #fds = new Map<string, OpenFile>();
  readonly #packageFiles?: PackageFiles;
  #nextFd = 1;
  #nextName = 1;

  constructor(options: { packageFiles?: PackageFiles } = {}) {
    this.#packageFiles = options.packageFiles;
    const now = Date.now();
    for (const root of [USER_DATA_PATH, TEMP_ROOT]) {
      this.#nodes.set(root, { type: "dir", mtime: now, atime: now, ctime: now });
    }
  }

  call(op: string, options: Record<string, unknown>, data?: Uint8Array): FsResult {
    // Arguments come from Mini Program code, which may pass any value
    const args = options as Record<string, any>;
    const path = (name = "path") => String(args[name] ?? "");
    switch (op) {
      case "access":
        this.#lookup(this.#locate(path()));
        return {};
      case "stat":
        return { value: this.#stat(path(), Boolean(args.recursive)) };
      case "readFile":
        return { data: this.#readFile(path(), args.position, args.length) };
      case "writeFile":
        this.#writeFile(this.#locate(path()), data ?? new Uint8Array(), Boolean(args.append));
        return {};
      case "writeTemp":
        return { value: this.#writeTemp(data ?? new Uint8Array(), String(args.extension ?? "")) };
      case "mkdir":
        this.#mkdir(path(), Boolean(args.recursive));
        return {};
      case "readdir":
        return { value: this.#readdir(this.#locate(path())) };
      case "rmdir":
        this.#rmdir(path(), Boolean(args.recursive));
        return {};
      case "unlink":
        this.#unlink(path());
        return {};
      case "rename":
        this.#rename(path("oldPath"), path("newPath"));
        return {};
      case "copyFile": {
        const source = this.#readFile(path("srcPath"));
        this.#writeFile(this.#locate(path("destPath")), source, false);
        return {};
      }
      case "truncate":
        this.#truncate(this.#locate(path()), Number(args.length ?? 0));
        return {};
      case "saveFile":
        return {
          value: this.#saveFile(path("tempFilePath"), args.filePath ? path("filePath") : undefined),
        };
      case "savedFiles":
        return { value: this.#savedFiles() };
      case "removeSavedFile":
        this.#removeSavedFile(path("filePath"));
        return {};
      case "open":
        return { value: this.#open(path(), String(args.flag ?? "r")) };
      case "close":
        this.#fd(args.fd);
        this.#fds.delete(String(args.fd));
        return {};
      case "fstat":
        return { value: this.#statsOf(this.#fdNode(this.#fd(args.fd))) };
      case "read":
        return { data: this.#read(this.#fd(args.fd), Number(args.length ?? 0), args.position) };
      case "write":
        return { value: this.#write(this.#fd(args.fd), data ?? new Uint8Array(), args.position) };
      case "ftruncate": {
        const file = this.#fd(args.fd);
        if (!file.writable) throw fail.fdPermission();
        this.#truncate({ area: "usr", key: file.key }, Number(args.length ?? 0));
        return {};
      }
      default:
        throw new ApiError(`unknown file system operation ${op}`);
    }
  }

  /** Parses a path into its area and normalized form; throws "no such file" for paths outside the file system. */
  #locate(path: string): Location {
    const prefixed = (root: string, area: Area): Location | undefined => {
      if (path !== root && !path.startsWith(`${root}/`)) return undefined;
      const parts: string[] = [];
      for (const part of path.slice(root.length).split("/")) {
        if (part === "" || part === ".") continue;
        if (part === "..") {
          if (!parts.pop()) throw fail.permission();
        } else parts.push(part);
      }
      return { area, key: [root, ...parts].join("/") };
    };
    const located = prefixed(USER_DATA_PATH, "usr") ?? prefixed(TEMP_ROOT, "tmp");
    if (located) return located;
    if (path.startsWith(STORE_PREFIX) && !path.includes("/", STORE_PREFIX.length)) {
      return { area: "store", key: path };
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path === "") throw fail.notFound(path);
    // Code package paths start at the Mini Program root; "./" and "../" are not allowed
    const relative = path.replace(/^\/+/, "");
    const parts = relative.split("/").filter((part) => part !== "");
    if (parts.some((part) => part === "." || part === "..")) throw fail.notFound(path);
    return { area: "package", key: parts.join("/") };
  }

  #find(location: Location): Node | undefined {
    if (location.area !== "package") return this.#nodes.get(location.key);
    const stat = this.#packageFiles?.stat(location.key);
    if (!stat) return undefined;
    if (stat.directory)
      return { type: "dir", mtime: stat.mtimeMs, atime: stat.mtimeMs, ctime: stat.mtimeMs };
    const read = () => this.#packageFiles?.read(location.key) ?? new Uint8Array();
    return {
      type: "file",
      get data() {
        return read();
      },
      mtime: stat.mtimeMs,
      atime: stat.mtimeMs,
      ctime: stat.mtimeMs,
    };
  }

  #lookup(location: Location, original = location.key): Node {
    const node = this.#find(location);
    if (!node) throw fail.notFound(original);
    return node;
  }

  #file(path: string): { location: Location; node: Extract<Node, { type: "file" }> } {
    const location = this.#locate(path);
    const node = this.#lookup(location, path);
    if (node.type !== "file") throw fail.directory();
    return { location, node };
  }

  /** The parent of a user or temporary path, which must be an existing directory. */
  #requireParent(location: Location, original: string) {
    const parent = location.key.slice(0, location.key.lastIndexOf("/"));
    const node = this.#nodes.get(parent);
    if (!node) throw fail.notFound(original);
    if (node.type !== "dir") throw fail.notDirectory();
  }

  #writable(location: Location) {
    if (location.area !== "usr") throw fail.permission();
  }

  #isRoot(location: Location) {
    return location.key === USER_DATA_PATH || location.key === TEMP_ROOT;
  }

  #storageUsed(): number {
    let total = 0;
    for (const [key, node] of this.#nodes) {
      if (node.type === "file" && !key.startsWith(TEMP_ROOT)) total += node.data.length;
    }
    return total;
  }

  #checkQuota(previous: number, next: number) {
    if (next > previous && this.#storageUsed() - previous + next > STORAGE_LIMIT)
      throw fail.limit();
  }

  #putFile(key: string, data: Uint8Array) {
    const now = Date.now();
    const existing = this.#nodes.get(key);
    const ctime = existing?.ctime ?? now;
    this.#nodes.set(key, { type: "file", data, mtime: now, atime: now, ctime });
  }

  #stat(path: string, recursive: boolean): StatsData | { path: string; stats: StatsData }[] {
    const location = this.#locate(path);
    const node = this.#lookup(location, path);
    if (!recursive || node.type !== "dir") return this.#statsOf(node);
    const entries: { path: string; stats: StatsData }[] = [];
    const walk = (current: Location, relative: string) => {
      const currentNode = this.#lookup(current);
      entries.push({ path: relative || "/", stats: this.#statsOf(currentNode) });
      if (currentNode.type !== "dir") return;
      for (const name of this.#readdir(current)) {
        walk(this.#child(current, name), `${relative}/${name}`);
      }
    };
    walk(location, "");
    return entries;
  }

  #child(location: Location, name: string): Location {
    return { area: location.area, key: location.key ? `${location.key}/${name}` : name };
  }

  #statsOf(node: Node): StatsData {
    const directory = node.type === "dir";
    return {
      mode: directory ? 0o40777 : 0o100666,
      size: node.type === "file" ? node.data.length : 0,
      lastAccessedTime: seconds(node.atime),
      lastModifiedTime: seconds(node.mtime),
      directory,
    };
  }

  #readFile(path: string, position?: unknown, length?: unknown): Uint8Array {
    const { node } = this.#file(path);
    const data = node.data;
    node.atime = Date.now();
    const start = position === undefined || position === null ? 0 : Number(position);
    if (!Number.isInteger(start) || start < 0 || (start > 0 && start >= data.length)) {
      throw fail.position();
    }
    let end = data.length;
    if (length !== undefined && length !== null) {
      const count = Number(length);
      if (!Number.isInteger(count) || count < 1 || start + count > data.length) throw fail.length();
      end = start + count;
    }
    return data.slice(start, end);
  }

  #writeFile(location: Location, data: Uint8Array, append: boolean) {
    this.#writable(location);
    const existing = this.#nodes.get(location.key);
    if (existing?.type === "dir") throw fail.directory();
    if (!existing) {
      if (append) throw fail.notFound(location.key);
      this.#requireParent(location, location.key);
    }
    const previous = existing?.type === "file" ? existing.data : new Uint8Array();
    const next = append ? new Uint8Array(previous.length + data.length) : copy(data);
    if (append) {
      next.set(previous);
      next.set(data, previous.length);
    }
    this.#checkQuota(previous.length, next.length);
    this.#putFile(location.key, next);
  }

  #writeTemp(data: Uint8Array, extension: string): string {
    const suffix = extension.replace(/^\./, "").replace(/[^a-zA-Z0-9]/g, "");
    const name = `omr_${(this.#nextName++).toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const key = `${TEMP_ROOT}/${name}${suffix ? `.${suffix}` : ""}`;
    this.#putFile(key, copy(data));
    return key;
  }

  #mkdir(path: string, recursive: boolean) {
    const location = this.#locate(path);
    this.#writable(location);
    const existing = this.#nodes.get(location.key);
    if (existing) {
      if (recursive && existing.type === "dir") return;
      throw fail.exists(path);
    }
    const parentKey = location.key.slice(0, location.key.lastIndexOf("/"));
    const parent = this.#nodes.get(parentKey);
    if (!parent) {
      if (!recursive) throw fail.notFound(path);
      this.#mkdir(parentKey, true);
    } else if (parent.type !== "dir") {
      throw fail.notDirectory();
    }
    const now = Date.now();
    this.#nodes.set(location.key, { type: "dir", mtime: now, atime: now, ctime: now });
  }

  #readdir(location: Location): string[] {
    const node = this.#lookup(location);
    if (node.type !== "dir") throw fail.notDirectory();
    if (location.area === "package") return this.#packageFiles?.list(location.key) ?? [];
    const prefix = `${location.key}/`;
    const names: string[] = [];
    for (const key of this.#nodes.keys()) {
      if (key.startsWith(prefix) && !key.includes("/", prefix.length)) {
        names.push(key.slice(prefix.length));
      }
    }
    return names;
  }

  #descendants(key: string): string[] {
    return [...this.#nodes.keys()].filter((other) => other.startsWith(`${key}/`));
  }

  #rmdir(path: string, recursive: boolean) {
    const location = this.#locate(path);
    this.#writable(location);
    const node = this.#lookup(location, path);
    if (node.type !== "dir") throw fail.notDirectory();
    if (this.#isRoot(location)) throw fail.notPermitted();
    const descendants = this.#descendants(location.key);
    if (descendants.length && !recursive) throw fail.notEmpty();
    for (const key of descendants) this.#nodes.delete(key);
    this.#nodes.delete(location.key);
  }

  /** Removes a user file; temporary files may be removed too, as the Mini Program owns them. */
  #unlink(path: string) {
    const location = this.#locate(path);
    if (location.area !== "tmp") this.#writable(location);
    const node = this.#lookup(location, path);
    if (node.type !== "file") throw fail.directory();
    this.#nodes.delete(location.key);
  }

  #rename(oldPath: string, newPath: string) {
    const source = this.#locate(oldPath);
    const target = this.#locate(newPath);
    if (source.area !== "tmp") this.#writable(source);
    this.#writable(target);
    const node = this.#lookup(source, oldPath);
    if (this.#isRoot(source)) throw fail.notPermitted();
    if (source.key === target.key) return;
    if (target.key.startsWith(`${source.key}/`)) throw fail.invalid();
    this.#requireParent(target, newPath);
    const existing = this.#nodes.get(target.key);
    if (existing) {
      if (node.type === "file" && existing.type === "dir") throw fail.directory();
      if (node.type === "dir" && existing.type === "file") throw fail.notDirectory();
      if (existing.type === "dir" && this.#descendants(target.key).length) throw fail.notEmpty();
    }
    if (source.area === "tmp" && node.type === "file") this.#checkQuota(0, node.data.length);
    const moved = [source.key, ...this.#descendants(source.key)];
    const entries = moved.map((key) => [key, this.#nodes.get(key)!] as const);
    for (const key of moved) this.#nodes.delete(key);
    for (const [key, value] of entries) {
      this.#nodes.set(target.key + key.slice(source.key.length), value);
    }
  }

  #truncate(location: Location, length: number) {
    this.#writable(location);
    const node = this.#lookup(location);
    if (node.type !== "file") throw fail.directory();
    if (!Number.isInteger(length) || length < 0) throw fail.length();
    const next = new Uint8Array(length);
    next.set(node.data.subarray(0, length));
    this.#checkQuota(node.data.length, length);
    this.#putFile(location.key, next);
  }

  #saveFile(tempFilePath: string, filePath: string | undefined): string {
    let source: { location: Location; node: Extract<Node, { type: "file" }> };
    try {
      source = this.#file(tempFilePath);
    } catch {
      throw fail.tempMissing();
    }
    let target: Location;
    if (!filePath) {
      const name = source.location.key.slice(source.location.key.lastIndexOf("/") + 1);
      target = { area: "store", key: `${STORE_PREFIX}${name}` };
      if (this.#nodes.has(target.key)) {
        target = {
          area: "store",
          key: `${STORE_PREFIX}${(this.#nextName++).toString(36)}_${name}`,
        };
      }
    } else {
      target = this.#locate(filePath);
      this.#writable(target);
      if (this.#nodes.get(target.key)?.type === "dir") throw fail.directory();
      this.#requireParent(target, filePath);
    }
    const data = source.node.data;
    const previous = this.#nodes.get(target.key);
    this.#checkQuota(previous?.type === "file" ? previous.data.length : 0, data.length);
    this.#putFile(target.key, data);
    // Saving moves the file: the temporary path is no longer valid
    if (source.location.area === "tmp" || source.location.area === "usr") {
      if (source.location.key !== target.key) this.#nodes.delete(source.location.key);
    }
    return target.key;
  }

  #savedFiles() {
    const files: { filePath: string; size: number; createTime: number }[] = [];
    for (const [key, node] of this.#nodes) {
      if (key.startsWith(STORE_PREFIX) && node.type === "file") {
        files.push({ filePath: key, size: node.data.length, createTime: seconds(node.ctime) });
      }
    }
    return files;
  }

  #removeSavedFile(path: string) {
    const location = this.#locate(path);
    if (location.area !== "store" && location.area !== "usr") throw fail.permission();
    const node = this.#lookup(location, path);
    if (node.type !== "file") throw fail.directory();
    this.#nodes.delete(location.key);
  }

  #open(path: string, flag: string): string {
    const mode = FLAGS[flag];
    if (!mode) throw fail.flag();
    const location = this.#locate(path);
    const existing = this.#find(location);
    if (mode.write) this.#writable(location);
    if (existing && mode.exclusive) throw fail.exists(path);
    if (existing?.type === "dir" && mode.write) throw fail.directory();
    if (!existing) {
      if (!mode.create) throw fail.notFound(path);
      this.#requireParent(location, path);
      this.#putFile(location.key, new Uint8Array());
    } else if (mode.truncate) {
      this.#putFile(location.key, new Uint8Array());
    }
    const fd = String(this.#nextFd++);
    this.#fds.set(fd, {
      key: location.area === "package" ? path : location.key,
      readable: mode.read,
      writable: mode.write,
      append: Boolean(mode.append),
      position: 0,
    });
    return fd;
  }

  #fd(fd: unknown): OpenFile {
    const file = this.#fds.get(String(fd));
    if (!file) throw fail.badFd();
    return file;
  }

  #fdNode(file: OpenFile): Node {
    const node = this.#find(this.#locate(file.key));
    if (!node) throw fail.badFd();
    return node;
  }

  #read(file: OpenFile, length: number, position: unknown): Uint8Array {
    if (!file.readable) throw fail.fdPermission();
    const node = this.#fdNode(file);
    if (node.type !== "file") throw fail.directory();
    const explicit = typeof position === "number" && position >= 0;
    const start = explicit ? position : file.position;
    if (!Number.isInteger(length) || length < 0) throw fail.length();
    const chunk = node.data.slice(start, start + length);
    node.atime = Date.now();
    if (!explicit) file.position += chunk.length;
    return chunk;
  }

  #write(file: OpenFile, data: Uint8Array, position: unknown): number {
    if (!file.writable) throw fail.fdPermission();
    const node = this.#fdNode(file);
    if (node.type !== "file") throw fail.directory();
    const explicit = typeof position === "number" && position >= 0;
    const start = file.append ? node.data.length : explicit ? position : file.position;
    const end = start + data.length;
    const next = new Uint8Array(Math.max(node.data.length, end));
    next.set(node.data);
    next.set(data, start);
    this.#checkQuota(node.data.length, next.length);
    this.#putFile(file.key, next);
    if (!explicit || file.append) file.position = end;
    return data.length;
  }
}

/**
 * The wire format of `FsHost.call` over HTTP: a 4-byte big-endian length, that
 * many bytes of JSON, then the binary data.
 */
function frame(json: unknown, data?: Uint8Array): Uint8Array<ArrayBuffer> {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const bytes = new Uint8Array(4 + text.length + (data?.length ?? 0));
  new DataView(bytes.buffer).setUint32(0, text.length);
  bytes.set(text, 4);
  if (data) bytes.set(data, 4 + text.length);
  return bytes;
}

function unframe(bytes: Uint8Array): { json: any; data: Uint8Array } {
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length))) as unknown;
  return { json, data: bytes.slice(4 + length) };
}

/** Answers one framed `FsHost.call` request, as the simulator server does. */
export function serveFsRequest(fs: FsHost, body: Uint8Array): Uint8Array<ArrayBuffer> {
  let result: FsResult;
  try {
    const { json, data } = unframe(body);
    const request = json as { op: string; args?: Record<string, unknown>; hasData?: boolean };
    result = fs.call(request.op, request.args ?? {}, request.hasData ? data : undefined);
  } catch (error) {
    const errno = (error as { errno?: number }).errno;
    return frame({ error: (error as Error).message ?? String(error), errno });
  }
  return frame({ value: result.value, hasData: result.data !== undefined }, result.data);
}

/** An `FsHost` that sends each call as a framed request, such as a synchronous XMLHttpRequest. */
export function remoteFs(send: (body: Uint8Array<ArrayBuffer>) => Uint8Array): FsHost {
  return {
    call(op, args, data) {
      const { json, data: bytes } = unframe(
        send(frame({ op, args, hasData: data !== undefined }, data)),
      );
      const response = json as {
        value?: unknown;
        hasData?: boolean;
        error?: string;
        errno?: number;
      };
      if (response.error !== undefined) throw new ApiError(response.error, response.errno);
      return { value: response.value, ...(response.hasData ? { data: bytes } : {}) };
    },
  };
}
