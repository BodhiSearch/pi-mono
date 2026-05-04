#!/usr/bin/env node
import { bootstrapCli } from "./bootstrap";

await bootstrapCli({
	input: process.stdin,
	output: process.stdout,
	exit: () => process.exit(0),
});
