#!/usr/bin/env node

try {
  if (process.argv[2] === 'setup') {
    process.argv.splice(2, 1);
    const { runSetup } = await import('./setup.js');
    await runSetup();
  } else {
    await import('./server.js');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
