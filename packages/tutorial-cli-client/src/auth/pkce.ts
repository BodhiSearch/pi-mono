import * as crypto from "node:crypto";

export interface PkcePair {
	verifier: string;
	challenge: string;
	state: string;
}

export function createPkcePair(): PkcePair {
	const verifier = base64UrlEncode(crypto.randomBytes(32));
	const challenge = base64UrlEncode(crypto.createHash("sha256").update(verifier).digest());
	const state = base64UrlEncode(crypto.randomBytes(16));
	return { verifier, challenge, state };
}

function base64UrlEncode(buf: Buffer): string {
	return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
