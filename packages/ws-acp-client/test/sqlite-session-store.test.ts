import { describe, expect, it } from "vitest";
import { openAppDb } from "../src/storage/db";
import { createSqliteSessionStore } from "../src/storage/sqlite-stores";

// Focused unit coverage for `listSummariesPage`, the missing piece that
// `Agent.listSessions` (post web-acp-agent refactor) requires. We keep
// this file tight: cover the empty store, single-page, multi-page
// boundary, and the descending-by-updatedAt sort contract. The rest of
// `SessionStore` is exercised end-to-end through the Playwright suite.
function makeStore() {
	const db = openAppDb("/tmp/ws-acp-client-tests-ignored", {
		filename: ":memory:",
		inMemory: true,
	});
	return createSqliteSessionStore(db);
}

async function seed(store: ReturnType<typeof makeStore>, count: number, baseAt = 1_000_000): Promise<string[]> {
	const ids: string[] = [];
	// Seed `count` sessions with monotonically-increasing `updatedAt` so
	// sort order is deterministic. We stagger by 100ms per insert.
	for (let i = 0; i < count; i++) {
		const id = `s${i.toString().padStart(2, "0")}`;
		await store.createSession(id, baseAt + i * 100);
		ids.push(id);
	}
	return ids;
}

describe("createSqliteSessionStore.listSummariesPage", () => {
	it("returns rows=[] and total=0 on an empty store", async () => {
		const store = makeStore();
		const page = await store.listSummariesPage({ page: 1, perPage: 50 });
		expect(page.rows).toEqual([]);
		expect(page.total).toBe(0);
	});

	it("returns every row when perPage exceeds total", async () => {
		const store = makeStore();
		await seed(store, 3);
		const page = await store.listSummariesPage({ page: 1, perPage: 50 });
		expect(page.rows).toHaveLength(3);
		expect(page.total).toBe(3);
		// Rows must be sorted by updatedAt DESC — most recent first.
		expect(page.rows.map((r) => r.id)).toEqual(["s02", "s01", "s00"]);
	});

	it("respects page + perPage on the multi-page boundary", async () => {
		const store = makeStore();
		await seed(store, 5);

		const page1 = await store.listSummariesPage({ page: 1, perPage: 2 });
		expect(page1.rows.map((r) => r.id)).toEqual(["s04", "s03"]);
		expect(page1.total).toBe(5);

		const page2 = await store.listSummariesPage({ page: 2, perPage: 2 });
		expect(page2.rows.map((r) => r.id)).toEqual(["s02", "s01"]);
		expect(page2.total).toBe(5);

		const page3 = await store.listSummariesPage({ page: 3, perPage: 2 });
		expect(page3.rows.map((r) => r.id)).toEqual(["s00"]);
		expect(page3.total).toBe(5);
	});

	it("returns an empty page past the end without throwing", async () => {
		const store = makeStore();
		await seed(store, 2);
		const page = await store.listSummariesPage({ page: 5, perPage: 10 });
		expect(page.rows).toEqual([]);
		expect(page.total).toBe(2);
	});

	it("clamps page=0 / page<0 to 1 (defensive)", async () => {
		const store = makeStore();
		await seed(store, 2);
		const zero = await store.listSummariesPage({ page: 0, perPage: 10 });
		expect(zero.rows.map((r) => r.id)).toEqual(["s01", "s00"]);
		const neg = await store.listSummariesPage({ page: -3, perPage: 10 });
		expect(neg.rows.map((r) => r.id)).toEqual(["s01", "s00"]);
	});
});
