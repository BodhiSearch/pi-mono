// Skill-nudge extension — exercises `pi.registerSkill`.
//
// Registers a single extension-contributed skill with a deterministic
// body. The main-thread slash palette lists it under
// `source: 'extension-skill'`, and `/skill:nudge` expands to the
// body wrapped in a `<skill>` block so the spec can assert via the
// ChatInput staged-message DOM without invoking the LLM.
export default function skillNudgeExtension(pi) {
  pi.registerSkill({
    name: 'nudge',
    description: 'Reminds the agent to double-check its work.',
    body: '# Nudge\n\nBefore answering, restate the user request in one sentence and list the files you plan to touch.',
  });

  pi.registerSkill({
    name: 'nudge-disabled',
    description: 'Deterministic skill with model invocation disabled.',
    body: '# Disabled skill\n\nThis skill should be flagged as disableModelInvocation.',
    disableModelInvocation: true,
  });
}
