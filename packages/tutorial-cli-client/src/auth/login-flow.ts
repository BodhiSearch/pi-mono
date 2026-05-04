import type { Emitter } from "../emitter";
import { getAccessRequestStatus, requestAccess } from "./access-request";
import { type PendingCallback, startCallbackServer } from "./callback-server";
import { APP_CLIENT_ID, buildScopeString, DEFAULT_AUTH_SERVER_URL, DEFAULT_CALLBACK_PORT } from "./config";
import { createPkcePair, type PkcePair } from "./pkce";
import { exchangeCodeForTokens, type TokenBundle } from "./token-exchange";

export interface LoginFlowOptions {
	bodhiUrl: string;
	authServerUrl?: string;
	callbackPort?: number;
	openBrowser: boolean;
	emitter: Emitter;
	timeoutMs?: number;
}

export interface LoginFlowResult {
	tokens: TokenBundle;
	bodhiUrl: string;
	authServerUrl: string;
	accessRequestId: string;
	accessRequestScope?: string;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export async function runLoginFlow(opts: LoginFlowOptions): Promise<LoginFlowResult> {
	const authServerUrl = opts.authServerUrl ?? DEFAULT_AUTH_SERVER_URL;
	const callbackPort = opts.callbackPort ?? DEFAULT_CALLBACK_PORT;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	const callbackServer = await startCallbackServer(callbackPort);
	try {
		const pkce = createPkcePair();
		const access = await requestAccess({
			bodhiUrl: opts.bodhiUrl,
			redirectUri: callbackServer.redirectUri,
		});

		opts.emitter.emit({
			text: `Open this URL in your browser to authorize: ${access.reviewUrl}`,
			login_url: access.reviewUrl,
		});

		if (opts.openBrowser) {
			await tryOpenBrowser(access.reviewUrl, opts.emitter);
		}

		const phase1 = await callbackServer.awaitNext(timeoutMs);
		const phase1Scope = await handlePhase1({
			phase1,
			bodhiUrl: opts.bodhiUrl,
			authServerUrl,
			pkce,
			redirectUri: callbackServer.redirectUri,
			accessRequestId: access.requestId,
		});

		const phase2 = await callbackServer.awaitNext(timeoutMs);
		if (phase2.event.kind === "error") {
			const message = phase2.event.description ?? phase2.event.error;
			phase2.respondError(message);
			throw new Error(`OAuth error: ${message}`);
		}
		if (phase2.event.kind !== "code") {
			phase2.respondError(`expected ?code=...&state=... callback, got ${phase2.event.kind}`);
			throw new Error(`unexpected callback after authorize: ${phase2.event.kind}`);
		}
		if (phase2.event.state !== pkce.state) {
			phase2.respondError("state mismatch — possible CSRF, aborting");
			throw new Error("callback state mismatch — possible CSRF, aborting login");
		}

		const tokens = await exchangeCodeForTokens({
			authServerUrl,
			code: phase2.event.code,
			codeVerifier: pkce.verifier,
			redirectUri: callbackServer.redirectUri,
		});
		phase2.respondSuccess();
		return {
			tokens,
			bodhiUrl: opts.bodhiUrl,
			authServerUrl,
			accessRequestId: access.requestId,
			accessRequestScope: phase1Scope,
		};
	} finally {
		await callbackServer.close();
	}
}

interface HandlePhase1Args {
	phase1: PendingCallback;
	bodhiUrl: string;
	authServerUrl: string;
	pkce: PkcePair;
	redirectUri: string;
	accessRequestId: string;
}

async function handlePhase1(args: HandlePhase1Args): Promise<string | undefined> {
	const { phase1, bodhiUrl, authServerUrl, pkce, redirectUri, accessRequestId } = args;
	if (phase1.event.kind === "error") {
		const message = phase1.event.description ?? phase1.event.error;
		phase1.respondError(message);
		throw new Error(`Bodhi access-request error: ${message}`);
	}
	if (phase1.event.kind !== "access_request") {
		phase1.respondError(`unexpected phase 1 callback (kind=${phase1.event.kind})`);
		throw new Error(`unexpected phase 1 callback: ${phase1.event.kind}`);
	}
	if (phase1.event.requestId !== accessRequestId) {
		phase1.respondError("access-request id mismatch");
		throw new Error("access-request id mismatch in callback");
	}

	const status = await getAccessRequestStatus(bodhiUrl, accessRequestId);
	if (status.status !== "approved") {
		phase1.respondError(`access request not approved (status=${status.status})`);
		throw new Error(`access request status: ${status.status}`);
	}

	const authorizeUrl = buildAuthorizeUrl({
		authServerUrl,
		accessRequestId,
		accessRequestScope: status.accessRequestScope,
		pkce,
		redirectUri,
	});
	phase1.respondRedirect(authorizeUrl);
	return status.accessRequestScope;
}

interface BuildAuthorizeUrlOptions {
	authServerUrl: string;
	accessRequestId: string;
	accessRequestScope?: string;
	pkce: PkcePair;
	redirectUri: string;
}

function buildAuthorizeUrl(opts: BuildAuthorizeUrlOptions): string {
	const url = new URL(`${stripTrailingSlash(opts.authServerUrl)}/protocol/openid-connect/auth`);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", APP_CLIENT_ID);
	url.searchParams.set("redirect_uri", opts.redirectUri);
	url.searchParams.set("scope", buildScopeString(opts.accessRequestId, opts.accessRequestScope));
	url.searchParams.set("state", opts.pkce.state);
	url.searchParams.set("code_challenge", opts.pkce.challenge);
	url.searchParams.set("code_challenge_method", "S256");
	return url.toString();
}

async function tryOpenBrowser(url: string, emitter: Emitter): Promise<void> {
	const { exec } = await import("node:child_process");
	const platform = process.platform;
	const cmd =
		platform === "darwin" ? `open "${url}"` : platform === "win32" ? `start "" "${url}"` : `xdg-open "${url}"`;
	exec(cmd, (err) => {
		if (err) emitter.emit({ text: `(could not auto-open browser: ${err.message})` });
	});
}

function stripTrailingSlash(value: string): string {
	return value.replace(/\/$/, "");
}
