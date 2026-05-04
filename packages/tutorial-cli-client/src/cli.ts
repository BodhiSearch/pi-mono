#!/usr/bin/env node
import * as path from "node:path";
import { bootstrapCli } from "./bootstrap";

const DEFAULT_BODHI_URL = "http://localhost:51135/";

interface ParsedArgs {
	test: boolean;
	bodhiUrl: string;
	cwd: string;
}

function parseArgs(argv: string[]): ParsedArgs {
	let test = false;
	let bodhiUrl = DEFAULT_BODHI_URL;
	let cwd = process.cwd();
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--test") {
			test = true;
		} else if (arg === "--bodhi-url") {
			const next = argv[++i];
			if (!next) throw new Error("--bodhi-url requires a value");
			bodhiUrl = next;
		} else if (arg === "--cwd") {
			const next = argv[++i];
			if (!next) throw new Error("--cwd requires a value");
			cwd = path.resolve(next);
		} else if (arg === "--help" || arg === "-h") {
			printUsage();
			process.exit(0);
		} else {
			throw new Error(`unknown argument: ${arg}`);
		}
	}
	return { test, bodhiUrl, cwd };
}

function printUsage(): void {
	process.stdout.write(
		[
			"tutorial-cli-client",
			"",
			"Usage: tutorial-cli-client [options]",
			"",
			"Options:",
			"  --bodhi-url <url>  BodhiApp base URL (default: http://localhost:51135/)",
			"  --cwd <path>       Working directory for .tutorial-cli-client/ (default: cwd)",
			"  --test             JSON-line output mode; do not open browser",
			"  -h, --help         Show this message",
			"",
		].join("\n"),
	);
}

const args = parseArgs(process.argv.slice(2));

await bootstrapCli({
	input: process.stdin,
	output: process.stdout,
	exit: () => process.exit(0),
	cwd: args.cwd,
	mode: args.test ? "test" : "plain",
	bodhiUrl: args.bodhiUrl,
	openBrowser: !args.test,
});
