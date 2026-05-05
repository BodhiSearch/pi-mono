export default function sessionCounter(pi) {
  let turns = 0;
  pi.on('session_start', async () => {
    turns = 0;
    await pi.session.appendEntry('counter', { turns });
  });
  pi.on('before_agent_start', async () => {
    turns += 1;
    await pi.session.appendEntry('counter', { turns });
  });
}
