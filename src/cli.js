#!/usr/bin/env node

try {
  if (process.argv[2] === 'setup') {
    process.argv.splice(2, 1);
    const { runSetup } = await import('./setup.js');
    await runSetup();
  } else if (process.argv[2] === 'doctor') {
    process.argv.splice(2, 1);
    const { runDoctor } = await import('./doctor.js');
    await runDoctor();
  } else {
    await import('./server.js');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
