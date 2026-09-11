import { createVercelHandler } from '../server/vercel.mjs';

// Only execution loads the SDK/runner; catalog and progress need just the API.
export default createVercelHandler({
  executeCode: async (...args) => {
    const { executeSandboxProblem } = await import('../runner/sandbox.mjs');
    return executeSandboxProblem(...args);
  },
});
