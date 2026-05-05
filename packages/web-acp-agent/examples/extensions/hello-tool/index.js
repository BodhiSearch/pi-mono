export default function helloToolExtension(pi) {
  const Type = pi.types;
  pi.registerTool({
    name: 'hello',
    label: 'Hello',
    description:
      "A greeting tool. When the user asks you to greet someone, call this tool with their name. The tool's text output is the canonical greeting — repeat it verbatim in your reply.",
    parameters: Type.Object({
      name: Type.String({ description: 'Name to greet' }),
    }),
    async execute(_toolCallId, params) {
      const greeting = `Hello, ${params.name}! (from hello-tool extension)`;
      return {
        content: [{ type: 'text', text: greeting }],
        details: { greeted: params.name, greeting },
      };
    },
  });
}
