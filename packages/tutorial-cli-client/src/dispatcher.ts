export interface DispatchContext {
	output: NodeJS.WritableStream;
}

export interface DispatchResult {
	exit: boolean;
}

export function dispatch(line: string, ctx: DispatchContext): DispatchResult {
	if (line === "/quit") {
		ctx.output.write("application exited\n");
		return { exit: true };
	}
	if (line === "") {
		return { exit: false };
	}
	ctx.output.write(`unknown command: ${line}\n`);
	return { exit: false };
}
