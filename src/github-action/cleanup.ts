import * as core from '@actions/core';

async function cleanup(): Promise<void> {
  try {
    core.info('ctxlint action cleanup completed');
  } catch (error) {
    core.warning(
      `Cleanup failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

// Run cleanup
cleanup();
