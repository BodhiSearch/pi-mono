import { fs } from "@zenfs/core";
import { umount } from "@zenfs/core/vfs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSeedInit } from "../../test-utils/seed-volume";
import { ZenfsVolumeRegistry } from "../volume-registry";
import { VolumeFileSystem } from "./volume-filesystem";

async function resetMount(mountName: string) {
	try {
		umount(`/mnt/${mountName}`);
	} catch {
		/* not mounted */
	}
}

describe("VolumeFileSystem", () => {
	let registry: ZenfsVolumeRegistry;

	beforeEach(async () => {
		await resetMount("wiki");
		registry = new ZenfsVolumeRegistry();
		await registry.mountAll([
			buildSeedInit({
				mountName: "wiki",
				files: {
					"/hello.md": "# hi\nfrom wiki",
					"/nested/inner.txt": "inside",
				},
			}),
		]);
	});

	afterEach(async () => {
		await resetMount("wiki");
	});

	it("reads files using mount-relative paths", async () => {
		const vfs = new VolumeFileSystem("/mnt/wiki");
		const raw = await vfs.readFile("/hello.md", { encoding: "utf8" });
		expect(raw).toContain("from wiki");
	});

	it("reads nested files under the mount root", async () => {
		const vfs = new VolumeFileSystem("/mnt/wiki");
		const raw = await vfs.readFile("/nested/inner.txt", { encoding: "utf8" });
		expect(raw).toBe("inside");
	});

	it("rejects paths without a leading slash", async () => {
		const vfs = new VolumeFileSystem("/mnt/wiki");
		await expect(vfs.readFile("hello.md", { encoding: "utf8" })).rejects.toThrow(/absolute paths/);
	});

	it("resolvePath composes with the base directory", () => {
		const vfs = new VolumeFileSystem("/mnt/wiki");
		expect(vfs.resolvePath("/a/b", "c")).toBe("/a/b/c");
		expect(vfs.resolvePath("/a/b", "/c")).toBe("/c");
		expect(vfs.resolvePath("/a/b", "../c")).toBe("/a/c");
	});

	it("writes files back through ZenFS", async () => {
		const vfs = new VolumeFileSystem("/mnt/wiki");
		await vfs.writeFile("/created.txt", "new", { encoding: "utf8" });
		const raw = await fs.promises.readFile("/mnt/wiki/created.txt", "utf8");
		expect(raw).toBe("new");
	});

	it("lists directory entries with dirent-like results", async () => {
		const vfs = new VolumeFileSystem("/mnt/wiki");
		const entries = await vfs.readdirWithFileTypes("/nested");
		expect(entries.map((e) => e.name).sort()).toContain("inner.txt");
	});

	it("stat returns size and kind", async () => {
		const vfs = new VolumeFileSystem("/mnt/wiki");
		const stat = await vfs.stat("/hello.md");
		expect(stat.isFile).toBe(true);
		expect(stat.isDirectory).toBe(false);
		expect(stat.size).toBeGreaterThan(0);
	});

	it("throws ENOENT for missing files", async () => {
		const vfs = new VolumeFileSystem("/mnt/wiki");
		await expect(vfs.readFile("/missing.md", { encoding: "utf8" })).rejects.toThrow();
	});
});
