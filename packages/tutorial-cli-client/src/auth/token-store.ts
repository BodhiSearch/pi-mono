import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { STORAGE_DIR_NAME, TOKEN_FILE_NAME } from "./config";
import type { TokenBundle } from "./token-exchange";

export interface StoredTokens extends TokenBundle {
	bodhiUrl: string;
	authServerUrl: string;
}

export function tokenFilePath(cwd: string): string {
	return join(cwd, STORAGE_DIR_NAME, TOKEN_FILE_NAME);
}

export async function readTokens(cwd: string): Promise<StoredTokens | null> {
	try {
		const raw = await readFile(tokenFilePath(cwd), "utf-8");
		const parsed = JSON.parse(raw) as Partial<StoredTokens>;
		if (typeof parsed.accessToken !== "string") return null;
		return parsed as StoredTokens;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
}

export async function writeTokens(cwd: string, tokens: StoredTokens): Promise<void> {
	const dir = join(cwd, STORAGE_DIR_NAME);
	await mkdir(dir, { recursive: true });
	await writeFile(tokenFilePath(cwd), `${JSON.stringify(tokens, null, 2)}\n`, "utf-8");
}

export function isTokenFresh(tokens: StoredTokens): boolean {
	return tokens.expiresAt - Date.now() > 30_000;
}
