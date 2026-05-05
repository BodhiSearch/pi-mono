export default function piGreetFixture(pi) {
  pi.registerCommand('pi-greet', {
    description: 'Greet a user with the pi-greet-fixture extension',
    handler: async (args) => {
      const who = args.trim() || 'world';
      return `pi-greet-fixture says: hello ${who}!`;
    },
  });
}
