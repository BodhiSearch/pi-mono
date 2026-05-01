/**
 * just-bash `IFileSystem` adapter over ZenFS.
 *
 * The worker-side `VolumeRegistry` mounts each volume at `/mnt/<name>`
 * on the global ZenFS VFS. When `MountableFs` dispatches to a
 * `VolumeFileSystem` instance registered at that same mount point, it
 * strips the mount prefix and passes us paths rooted at `/`. We translate
 * those relative paths back to absolute ZenFS paths by prepending
 * `root` (e.g. `/mnt/wiki`) and delegate to `fs.promises.*`.
 *
 * All path inputs arriving from `MountableFs` start with `/`. The adapter
 * handles the special `/` case for mount-root stat / readdir operations.
 */
import { fs as zenfs } from "@zenfs/core";
import type {
	BufferEncoding,
	CpOptions,
	DirentEntry,
	FileContent,
	FsStat,
	IFileSystem,
	MkdirOptions,
	ReadFileOptions,
	RmOptions,
	WriteFileOptions,
} from "just-bash/browser";

type ReadFileArg = ReadFileOptions | BufferEncoding | undefined;
type WriteFileArg = WriteFileOptions | BufferEncoding | undefined;

export class VolumeFileSystem implements IFileSystem {
	readonly root: string;

	constructor(root: string) {
		if (!root.startsWith("/")) {
			throw new Error(`VolumeFileSystem root must be absolute, got '${root}'`);
		}
		this.root = root.endsWith("/") && root !== "/" ? root.slice(0, -1) : root;
	}

	async readFile(path: string, options?: ReadFileArg): Promise<string> {
		const encoding = resolveReadEncoding(options);
		const buffer = await zenfs.promises.readFile(this.abs(path));
		return decodeBuffer(buffer, encoding);
	}

	async readFileBuffer(path: string): Promise<Uint8Array> {
		const buffer = await zenfs.promises.readFile(this.abs(path));
		return toUint8Array(buffer);
	}

	async writeFile(path: string, content: FileContent, options?: WriteFileArg): Promise<void> {
		const encoding = resolveWriteEncoding(options);
		await zenfs.promises.writeFile(this.abs(path), toNodePayload(content, encoding));
	}

	async appendFile(path: string, content: FileContent, options?: WriteFileArg): Promise<void> {
		const encoding = resolveWriteEncoding(options);
		await zenfs.promises.appendFile(this.abs(path), toNodePayload(content, encoding));
	}

	async exists(path: string): Promise<boolean> {
		try {
			await zenfs.promises.stat(this.abs(path));
			return true;
		} catch {
			return false;
		}
	}

	async stat(path: string): Promise<FsStat> {
		const s = await zenfs.promises.stat(this.abs(path));
		return toFsStat(s);
	}

	async lstat(path: string): Promise<FsStat> {
		const s = await zenfs.promises.lstat(this.abs(path));
		return toFsStat(s);
	}

	async mkdir(path: string, options?: MkdirOptions): Promise<void> {
		await zenfs.promises.mkdir(this.abs(path), { recursive: options?.recursive ?? false });
	}

	async readdir(path: string): Promise<string[]> {
		const entries = await zenfs.promises.readdir(this.abs(path));
		return entries.map((e) => (typeof e === "string" ? e : String(e)));
	}

	async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
		const entries = await zenfs.promises.readdir(this.abs(path), { withFileTypes: true });
		return entries.map((entry) => ({
			name: entry.name,
			isFile: entry.isFile(),
			isDirectory: entry.isDirectory(),
			isSymbolicLink: entry.isSymbolicLink(),
		}));
	}

	async rm(path: string, options?: RmOptions): Promise<void> {
		await zenfs.promises.rm(this.abs(path), {
			recursive: options?.recursive ?? false,
			force: options?.force ?? false,
		});
	}

	async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
		await zenfs.promises.cp(this.abs(src), this.abs(dest), {
			recursive: options?.recursive ?? false,
		});
	}

	async mv(src: string, dest: string): Promise<void> {
		await zenfs.promises.rename(this.abs(src), this.abs(dest));
	}

	resolvePath(base: string, path: string): string {
		return posixResolve(base, path);
	}

	getAllPaths(): string[] {
		return [];
	}

	async chmod(path: string, mode: number): Promise<void> {
		try {
			await zenfs.promises.chmod(this.abs(path), mode);
		} catch (err) {
			// Some backends (FSA `WebAccess`) don't support chmod; silently
			// swallow ENOSYS so bash commands like `chmod +x` don't explode.
			if (!isEnosys(err)) throw err;
		}
	}

	async symlink(target: string, linkPath: string): Promise<void> {
		await zenfs.promises.symlink(target, this.abs(linkPath));
	}

	async link(existingPath: string, newPath: string): Promise<void> {
		await zenfs.promises.link(this.abs(existingPath), this.abs(newPath));
	}

	async readlink(path: string): Promise<string> {
		const result = await zenfs.promises.readlink(this.abs(path));
		return typeof result === "string" ? result : String(result);
	}

	async realpath(path: string): Promise<string> {
		const abs = await zenfs.promises.realpath(this.abs(path));
		const absStr = typeof abs === "string" ? abs : String(abs);
		if (absStr === this.root) return "/";
		if (absStr.startsWith(`${this.root}/`)) return absStr.slice(this.root.length);
		return absStr;
	}

	async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
		await zenfs.promises.utimes(this.abs(path), atime, mtime);
	}

	private abs(path: string): string {
		if (!path.startsWith("/")) {
			throw new Error(`VolumeFileSystem expects absolute paths, got '${path}'`);
		}
		if (path === "/") return this.root;
		return `${this.root}${path}`;
	}
}

function resolveReadEncoding(options?: ReadFileOptions | BufferEncoding): BufferEncoding | null {
	if (!options) return "utf8";
	if (typeof options === "string") return options;
	return options.encoding ?? null;
}

function resolveWriteEncoding(options?: WriteFileOptions | BufferEncoding): BufferEncoding {
	if (!options) return "utf8";
	if (typeof options === "string") return options;
	return options.encoding ?? "utf8";
}

function decodeBuffer(buffer: unknown, encoding: BufferEncoding | null): string {
	const bytes = toUint8Array(buffer);
	if (encoding === null || encoding === "binary" || encoding === "latin1") {
		let out = "";
		for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
		return out;
	}
	if (encoding === "hex") {
		let out = "";
		for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
		return out;
	}
	if (encoding === "base64") {
		if (typeof btoa === "function") {
			let binary = "";
			for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
			return btoa(binary);
		}
		return Buffer.from(bytes).toString("base64");
	}
	return new TextDecoder("utf-8").decode(bytes);
}

function toUint8Array(value: unknown): Uint8Array {
	if (value instanceof Uint8Array) return value;
	if (ArrayBuffer.isView(value)) {
		const view = value as ArrayBufferView;
		return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
	}
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	if (typeof value === "string") return new TextEncoder().encode(value);
	throw new Error(`Unsupported buffer value: ${typeof value}`);
}

function toNodePayload(content: FileContent, encoding: BufferEncoding): string | Uint8Array {
	if (typeof content === "string") {
		if (encoding === "utf8" || encoding === "utf-8") return content;
		if (encoding === "binary" || encoding === "latin1") {
			const bytes = new Uint8Array(content.length);
			for (let i = 0; i < content.length; i++) bytes[i] = content.charCodeAt(i) & 0xff;
			return bytes;
		}
		if (encoding === "hex") {
			const clean = content.replace(/[^0-9a-fA-F]/g, "");
			const bytes = new Uint8Array(Math.floor(clean.length / 2));
			for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
			return bytes;
		}
		if (encoding === "base64") {
			if (typeof atob === "function") {
				const binary = atob(content);
				const bytes = new Uint8Array(binary.length);
				for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
				return bytes;
			}
			return Uint8Array.from(Buffer.from(content, "base64"));
		}
		return content;
	}
	return content;
}

interface ZenfsStats {
	mode?: number;
	size?: number;
	mtime?: Date | number;
	isFile(): boolean;
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
}

function toFsStat(s: ZenfsStats): FsStat {
	const mtime = s.mtime instanceof Date ? s.mtime : new Date(Number(s.mtime ?? 0));
	return {
		isFile: s.isFile(),
		isDirectory: s.isDirectory(),
		isSymbolicLink: s.isSymbolicLink(),
		mode: Number(s.mode ?? 0),
		size: Number(s.size ?? 0),
		mtime,
	};
}

function isEnosys(err: unknown): boolean {
	if (err === null || typeof err !== "object") return false;
	const code = (err as { code?: string }).code;
	return code === "ENOSYS" || code === "EPERM";
}

/**
 * POSIX-style `path.resolve`. Mirrors `node:path/posix.resolve` enough
 * for bash usage without pulling a full polyfill.
 */
function posixResolve(...segments: string[]): string {
	let resolved = "";
	let absolute = false;
	for (let i = segments.length - 1; i >= -1 && !absolute; i--) {
		const segment = i >= 0 ? segments[i] : "/";
		if (!segment) continue;
		resolved = `${segment}/${resolved}`;
		absolute = segment.startsWith("/");
	}
	const normalized = normalizePosix(resolved, !absolute);
	if (absolute) return normalized ? `/${normalized}` : "/";
	return normalized || ".";
}

function normalizePosix(path: string, allowAboveRoot: boolean): string {
	const parts: string[] = [];
	for (const part of path.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") {
			if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
			else if (allowAboveRoot) parts.push("..");
			continue;
		}
		parts.push(part);
	}
	return parts.join("/");
}
