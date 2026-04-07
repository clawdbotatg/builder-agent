import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { callLLM } from './llm.js';
import { prepareStepContext } from './context.js';
import { writeFile, log } from './utils.js';

/**
 * Execute all steps in sequence, maintaining state between them.
 */
export async function executeSteps(steps, buildPath, job, skills) {
  const buildState = {
    job,
    skills,           // condensed skill docs
    projectPath: null, // set after scaffolding
    agentsMd: null,    // set after reading AGENTS.md
    completedSteps: [],
    buildPath,
  };

  // Create step logs directory
  const logsDir = path.join(buildPath, 'step-logs');
  fs.mkdirSync(logsDir, { recursive: true });

  for (const step of steps) {
    log(`\n${'='.repeat(60)}`);
    log(`STEP ${step.step}: ${step.name} [${step.model}]${step.gate ? ' [GATE]' : ''}`);
    log(`${'='.repeat(60)}`);

    const stepDir = path.join(logsDir, `step-${String(step.step).padStart(2, '0')}-${step.name}`);
    fs.mkdirSync(stepDir, { recursive: true });

    const maxRetries = isCodeStep(step) ? 1 : 0; // Retry code steps once
    let lastError = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          log(`  ↻ Retry ${attempt}/${maxRetries}...`);
        }

        // 1. CONTEXT — minimax prepares the prompt
        log(`  Preparing context...`);
        const { systemPrompt, userPrompt } = await prepareStepContext(step, buildState);

        writeFile(path.join(stepDir, `system-prompt${attempt > 0 ? `-retry${attempt}` : ''}.md`), systemPrompt);
        writeFile(path.join(stepDir, `user-prompt${attempt > 0 ? `-retry${attempt}` : ''}.md`), userPrompt);

        // On retry, append the error from the previous attempt to help the LLM fix it
        let retryContext = '';
        if (attempt > 0 && lastError) {
          retryContext = `\n\n⚠️ PREVIOUS ATTEMPT FAILED: ${lastError}\nFix the issue and try again. Make sure to output COMPLETE file contents.`;
        }

        // 2. EXECUTE — call the target model or run commands
        let result;

        if (step.name === 'read-agents-md' || step.name === 'read-agents') {
          result = await executeReadAgentsStep(step, buildState);
        } else if (isCommandStep(step)) {
          result = await executeCommandStep(step, buildState, systemPrompt, userPrompt);
        } else if (step.gate) {
          result = await executeGateStep(step, buildState, systemPrompt, userPrompt);
        } else if (isCodeStep(step)) {
          result = await executeCodeStep(step, buildState, systemPrompt, userPrompt + retryContext);
        } else {
          result = await executeGenericStep(step, buildState, systemPrompt, userPrompt);
        }

        writeFile(path.join(stepDir, `result${attempt > 0 ? `-retry${attempt}` : ''}.md`), result.output || 'No output');
        if (result.files) {
          writeFile(path.join(stepDir, 'files-written.json'), JSON.stringify(result.files, null, 2));
        }

        // 3. EVALUATE — check if step succeeded
        log(`  Evaluating...`);
        const evaluation = await evaluateStep(step, result, buildState);
        writeFile(path.join(stepDir, `evaluation${attempt > 0 ? `-retry${attempt}` : ''}.md`), evaluation.summary);

        // 4. UPDATE STATE — always update state
        updateBuildState(step, result, buildState);

        if (!evaluation.passed) {
          lastError = evaluation.reason;
          if (attempt < maxRetries) {
            log(`  ✗ FAILED (will retry): ${evaluation.reason}`);
            continue; // retry
          }
          log(`  ✗ FAILED: ${evaluation.reason}`);
          writeFile(path.join(stepDir, 'FAILED.md'), evaluation.reason);
          buildState.completedSteps.push({
            ...step,
            result: `FAILED: ${evaluation.reason}`,
          });
          break;
        }

        log(`  ✓ PASSED`);
        buildState.completedSteps.push({
          ...step,
          result: 'done',
        });
        break; // success, stop retrying

      } catch (err) {
        lastError = err.message;
        if (attempt < maxRetries) {
          log(`  ✗ ERROR (will retry): ${err.message}`);
          continue;
        }
        log(`  ✗ ERROR: ${err.message}`);
        writeFile(path.join(stepDir, 'ERROR.md'), err.stack || err.message);
        buildState.completedSteps.push({
          ...step,
          result: `ERROR: ${err.message}`,
        });
      }
    }
  }

  // Clean up background processes
  if (buildState.forkProcess) {
    log(`\nStopping fork process...`);
    try {
      process.kill(-buildState.forkProcess.pid, 'SIGTERM');
    } catch (e) {
      // Process may already be dead
    }
  }

  return buildState;
}

// --- Step type detection ---

function isCommandStep(step) {
  const commandPatterns = [
    'scaffold-', 'start-', 'deploy-to-', 'run-', 'install-',
    'fund-', 'verify-', 'build-for-ipfs', 'upload-to-ipfs',
  ];
  return commandPatterns.some(prefix => step.name.includes(prefix));
}

function isCodeStep(step) {
  // Command steps are NOT code steps (even if they produce file outputs)
  if (isCommandStep(step)) return false;
  // Opus always writes code
  if (step.model === 'opus') return true;
  // Steps that write/build/configure/create files are code steps
  if (step.name.startsWith('write-')) return true;
  if (step.name.startsWith('build-') && !step.name.includes('ipfs')) return true;
  if (step.name.startsWith('configure-')) return true;
  if (step.name.startsWith('create-')) return true;
  if (step.name.includes('update-metadata')) return true;
  if (step.name.includes('add-styling')) return true;
  return false;
}

// --- Step executors ---

async function executeReadAgentsStep(step, buildState) {
  if (!buildState.projectPath) {
    return { output: 'FAILED: projectPath not set — scaffold step may not have run', exitCode: 1, files: [] };
  }
  const agentsPath = path.join(buildState.projectPath, 'AGENTS.md');
  if (!fs.existsSync(agentsPath)) {
    return { output: `FAILED: AGENTS.md not found at ${agentsPath}`, exitCode: 1, files: [] };
  }
  const content = fs.readFileSync(agentsPath, 'utf-8');
  buildState.agentsMd = content;
  log(`  Loaded AGENTS.md (${content.length} chars)`);
  return { output: `Read AGENTS.md (${content.length} chars). Key conventions loaded.`, exitCode: 0, files: [] };
}

async function executeCommandStep(step, buildState, systemPrompt, userPrompt) {
  // For command steps, we either know the command or ask minimax to determine it
  const command = extractCommand(step, buildState);

  if (!command) {
    // Ask minimax what command to run
    const response = await callLLM('minimax',
      'You output shell commands. Output ONLY the command, no explanation, no markdown.',
      `What shell command should I run for this step?\n\nStep: ${step.name}\nDescription: ${step.description}\nProject path: ${buildState.projectPath || 'not yet created'}\n\n${userPrompt}`,
      { maxTokens: 256, label: `cmd-${step.name}` }
    );
    return await runCommand(response.trim(), buildState);
  }

  // Longer timeout for scaffold/install
  const timeout = (step.name.includes('scaffold') || step.name.includes('install')) ? 300_000 : 120_000;
  return await runCommand(command, buildState, { timeout });
}

function extractCommand(step, buildState) {
  const projectDir = buildState.projectPath;
  const name = step.name;

  // Known commands for specific steps
  if (name.includes('scaffold')) {
    // Extract project name from step outputs or description
    let projectName = `job-${buildState.job.id}-app`;
    if (step.outputs && step.outputs[0]) {
      projectName = step.outputs[0].replace(/\/$/, '');
    } else if (step.description) {
      const match = step.description.match(/create-eth@latest\s+-s\s+foundry\s+(\S+)/);
      if (match) projectName = match[1];
    }
    // create-eth creates a subdirectory with the project name
    // Pipe the name via stdin since it prompts interactively
    return `cd "${buildState.buildPath}" && echo "${projectName}" | npx -y create-eth@latest -s foundry`;
  }
  if (name === 'deploy-to-local-fork') {
    return projectDir ? `cd "${projectDir}" && LOCALHOST_KEYSTORE_ACCOUNT=scaffold-eth-default yarn deploy` : null;
  }
  if (name === 'deploy-to-base' || name === 'deploy-to-live') {
    return projectDir ? `cd "${projectDir}" && yarn deploy --network base` : null;
  }
  if (name.includes('fork') || name.includes('start-base')) {
    return projectDir ? `cd "${projectDir}" && yarn fork --network base` : null;
  }
  if (name.includes('run-forge-test') || name.includes('run-test')) {
    return projectDir ? `cd "${projectDir}" && forge test --root packages/foundry` : null;
  }
  if (name.includes('verify')) {
    return projectDir ? `cd "${projectDir}" && yarn verify --network base` : null;
  }
  if (name.includes('install-dep')) {
    return projectDir ? `cd "${projectDir}" && yarn install` : null;
  }
  if (name === 'start-frontend-localhost') {
    // Don't actually start the server in the executor — just verify it builds
    return projectDir ? `cd "${projectDir}" && yarn next:build` : null;
  }
  if (name === 'build-for-ipfs') {
    return projectDir
      ? `cd "${projectDir}/packages/nextjs" && rm -rf .next out && NEXT_PUBLIC_IPFS_BUILD=true NODE_OPTIONS="--require ./polyfill-localstorage.cjs" npm run build`
      : null;
  }
  if (name === 'upload-to-ipfs') {
    return projectDir
      ? `bgipfs upload "${projectDir}/packages/nextjs/out" --config ~/.bgipfs/credentials.json`
      : null;
  }

  return null;
}

function runCommand(command, buildState, options = {}) {
  log(`  Running: ${command.length > 100 ? command.slice(0, 100) + '...' : command}`);
  const timeout = options.timeout || 120_000;

  // Background processes (fork, dev server) — spawn detached and wait for readiness
  if (command.includes('yarn fork')) {
    return spawnForkProcess(command, buildState);
  }
  if (command.includes('yarn start')) {
    log(`  ⚠ Skipping dev server — use yarn next:build to verify instead`);
    return { output: 'Dev server skipped (not needed for automated build)', exitCode: 0, files: [] };
  }

  try {
    const output = execSync(command, {
      encoding: 'utf-8',
      timeout,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    log(`  Command succeeded`);
    return { output: output.slice(-2000), exitCode: 0, files: [] };
  } catch (err) {
    const stderr = err.stderr || '';
    const stdout = err.stdout || '';
    log(`  Command failed (exit ${err.status})`);
    return {
      output: `FAILED (exit ${err.status}):\nSTDOUT:\n${stdout.slice(-1000)}\nSTDERR:\n${stderr.slice(-1000)}`,
      exitCode: err.status,
      files: [],
    };
  }
}

function spawnForkProcess(command, buildState) {
  const projectDir = buildState.projectPath;
  if (!projectDir) {
    return { output: 'FAILED: projectPath not set', exitCode: 1, files: [] };
  }

  log(`  Spawning fork process in background...`);

  // Extract the actual command parts
  const forkProc = spawn('yarn', ['fork', '--network', 'base'], {
    cwd: projectDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: { ...process.env, FORCE_COLOR: '0' },
  });

  // Store the process so we can kill it later
  buildState.forkProcess = forkProc;

  // Wait up to 15 seconds for the fork to be ready (listening on port 8545)
  return new Promise((resolve) => {
    let output = '';
    let resolved = false;

    const done = (exitCode) => {
      if (resolved) return;
      resolved = true;
      resolve({ output: output.slice(-2000), exitCode, files: [] });
    };

    forkProc.stdout.on('data', (data) => {
      output += data.toString();
      // Anvil prints "Listening on 127.0.0.1:8545" when ready
      if (output.includes('Listening on')) {
        log(`  Fork ready (listening on 8545)`);
        forkProc.unref(); // Allow parent to exit without killing fork
        done(0);
      }
    });

    forkProc.stderr.on('data', (data) => {
      output += data.toString();
    });

    forkProc.on('error', (err) => {
      log(`  Fork process error: ${err.message}`);
      done(1);
    });

    forkProc.on('exit', (code) => {
      if (!resolved) {
        log(`  Fork process exited with code ${code}`);
        done(code || 1);
      }
    });

    // Timeout after 30 seconds
    setTimeout(() => {
      if (!resolved) {
        log(`  Fork startup timed out (30s) — continuing anyway`);
        forkProc.unref();
        done(0); // Don't fail — fork might still be starting
      }
    }, 30_000);
  });
}

async function executeCodeStep(step, buildState, systemPrompt, userPrompt) {
  // Call the target model to generate code
  const maxTokens = step.model === 'opus' ? 8192 : step.model === 'sonnet' ? 8192 : 2048;

  // Append output format instruction to user prompt
  const formatInstruction = `\n\nIMPORTANT OUTPUT FORMAT: You must output the COMPLETE file content. Do NOT describe what you would do — actually write the code. Do NOT use tool calls or placeholder comments. For each file, use this exact format:\n\nFILE: path/to/file.ext\n\`\`\`lang\n<complete file content here>\n\`\`\`\n\nUse the full relative path (e.g., packages/foundry/contracts/GuestBook.sol).`;

  const response = await callLLM(step.model,
    systemPrompt,
    userPrompt + formatInstruction,
    { maxTokens, label: `code-${step.name}` }
  );

  // Parse code blocks and file paths from the response
  const files = extractFilesFromResponse(response, step, buildState);

  // Write files to disk (with safeguards for infrastructure scaffold files)
  const PROTECTED_FILES = [
    'foundry.toml', 'DeployHelpers.s.sol', 'VerifyAll.s.sol',
    'scaffold.config.ts', 'package.json', 'tsconfig.json', 'next.config.ts',
    'layout.tsx', // app/layout.tsx is the root layout — don't overwrite
  ];

  const writtenBasenames = [];
  for (const file of files) {
    const fullPath = resolveFilePath(file.path, buildState);
    if (!fullPath) continue;

    const basename = path.basename(file.path);
    if (PROTECTED_FILES.includes(basename) && fs.existsSync(fullPath)) {
      log(`  ⚠ Skipping protected file: ${file.path} (already exists from scaffold)`);
      continue;
    }

    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, file.content, 'utf-8');
    log(`  Wrote: ${file.path}`);
    writtenBasenames.push(basename);
  }

  // Clean up default scaffold files that our new files replace
  if (buildState.projectPath) {
    cleanupDefaultScaffoldFiles(buildState.projectPath, writtenBasenames, step);
  }

  const writtenFiles = files.map(f => f.path);

  // If we wrote Solidity files, verify compilation immediately
  if (buildState.projectPath && writtenFiles.some(f => f.endsWith('.sol'))) {
    try {
      const compileOutput = execSync(`forge build --root packages/foundry`, {
        cwd: buildState.projectPath,
        encoding: 'utf-8',
        timeout: 30_000,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '0' },
      });
      log(`  Compilation check: ✓`);
    } catch (err) {
      const stderr = (err.stderr || '').slice(-500);
      log(`  Compilation check: ✗`);
      return {
        output: `Code written but FAILED compilation:\n${stderr}`,
        exitCode: 1,
        files: writtenFiles,
      };
    }
  }

  return { output: response, files: writtenFiles };
}

async function executeGateStep(step, buildState, systemPrompt, userPrompt) {
  // Gather current state for evaluation
  const stateReport = gatherStateReport(buildState);

  const evaluation = await callLLM('sonnet',
    systemPrompt,
    `Evaluate this validation gate.\n\n## Gate Criteria\n${step.evaluation}\n\n## Current State\n${stateReport}\n\n## Previous Steps\n${buildState.completedSteps.map(s => `${s.step}. ${s.name}: ${s.result}`).join('\n')}\n\nOutput PASS or FAIL followed by a brief explanation.`,
    { maxTokens: 512, label: `gate-${step.name}` }
  );

  return { output: evaluation, files: [] };
}

async function executeGenericStep(step, buildState, systemPrompt, userPrompt) {
  const response = await callLLM(step.model,
    systemPrompt,
    userPrompt,
    { maxTokens: 1024, label: `generic-${step.name}` }
  );

  return { output: response, files: [] };
}

// --- Scaffold cleanup ---

function cleanupDefaultScaffoldFiles(projectPath, writtenBasenames, step) {
  // If we wrote a new contract, remove the default YourContract.sol
  if (step.name.includes('contract') && !step.name.includes('test')) {
    const defaultContract = path.join(projectPath, 'packages/foundry/contracts/YourContract.sol');
    if (fs.existsSync(defaultContract) && writtenBasenames.some(b => b.endsWith('.sol') && b !== 'YourContract.sol')) {
      fs.unlinkSync(defaultContract);
      log(`  🧹 Removed default YourContract.sol`);
    }
  }

  // If we wrote a new deploy script, remove the default DeployYourContract.s.sol
  if (step.name.includes('deploy') && !step.name.includes('deploy-to')) {
    const defaultDeploy = path.join(projectPath, 'packages/foundry/script/DeployYourContract.s.sol');
    if (fs.existsSync(defaultDeploy) && writtenBasenames.some(b => b.endsWith('.s.sol') && b !== 'DeployYourContract.s.sol')) {
      fs.unlinkSync(defaultDeploy);
      log(`  🧹 Removed default DeployYourContract.s.sol`);
    }
  }

  // If we wrote new tests, remove the default YourContract.t.sol
  if (step.name.includes('test')) {
    const defaultTest = path.join(projectPath, 'packages/foundry/test/YourContract.t.sol');
    if (fs.existsSync(defaultTest) && writtenBasenames.some(b => b.endsWith('.t.sol') && b !== 'YourContract.t.sol')) {
      fs.unlinkSync(defaultTest);
      log(`  🧹 Removed default YourContract.t.sol`);
    }
  }
}

// --- File extraction ---

function extractFilesFromResponse(response, step, buildState) {
  const files = [];

  // Strategy 1: Look for FILE: markers (our instructed format)
  // Pattern: FILE: path/to/file\n```lang\n...``` (or truncated if response hit token limit)
  const fileMarkerRegex = /FILE:\s*(\S+)\s*\n```\w*\n([\s\S]*?)(?:```|$)/g;
  let match;
  while ((match = fileMarkerRegex.exec(response)) !== null) {
    files.push({ path: match[1], content: match[2].trim() });
  }

  if (files.length > 0) return files;

  // Strategy 2: Look for ### path or **path** before code blocks
  const headerBlockRegex = /(?:#{1,3}\s+|(?:\*\*))(`?)((?:packages\/|[A-Z][a-zA-Z]+\.)[^\s`*\n]+)`?\1(?:\*\*)?\s*\n+```\w*\n([\s\S]*?)(?:```|$)/g;
  while ((match = headerBlockRegex.exec(response)) !== null) {
    files.push({ path: match[2], content: match[3].trim() });
  }

  if (files.length > 0) return files;

  // Strategy 3: Look for // File: or // Path: comments at the start of code blocks
  const commentBlockRegex = /```\w*\n\/\/\s*(?:File|Path|SPDX)[^\n]*\n?\/\/\s*(?:File|Path):\s*(\S+)\n([\s\S]*?)```/g;
  while ((match = commentBlockRegex.exec(response)) !== null) {
    files.push({ path: match[1], content: match[2].trim() });
  }

  if (files.length > 0) return files;

  // Strategy 4: If step has specific outputs, match code blocks to outputs in order
  if (step.outputs && step.outputs.length > 0) {
    const codeBlocks = [];
    const blockRegex = /```(?:solidity|typescript|tsx|javascript|js|ts|cjs|lang)\n([\s\S]*?)(?:```|$)/g;
    while ((match = blockRegex.exec(response)) !== null) {
      codeBlocks.push(match[1].trim());
    }

    const fileOutputs = step.outputs.filter(o =>
      o.includes('/') || o.endsWith('.sol') || o.endsWith('.ts') || o.endsWith('.tsx') || o.endsWith('.cjs')
    );

    for (let i = 0; i < Math.min(fileOutputs.length, codeBlocks.length); i++) {
      files.push({ path: fileOutputs[i], content: codeBlocks[i] });
    }
  }

  return files;
}

function resolveFilePath(filePath, buildState) {
  if (!buildState.projectPath) return null;

  // If path starts with packages/, it's relative to the project root
  if (filePath.startsWith('packages/')) {
    return path.join(buildState.projectPath, filePath);
  }

  // App Router paths: app/page.tsx, app/signer/[address]/page.tsx
  if (filePath.startsWith('app/')) {
    return path.join(buildState.projectPath, 'packages/nextjs', filePath);
  }

  // Components path: components/GuestbookEntry.tsx
  if (filePath.startsWith('components/')) {
    return path.join(buildState.projectPath, 'packages/nextjs', filePath);
  }

  // If it's just a filename, try to place it intelligently
  if (filePath.endsWith('.sol') && !filePath.includes('/')) {
    // .t.sol → test, .s.sol → script, else → contracts
    if (filePath.endsWith('.t.sol')) {
      return path.join(buildState.projectPath, 'packages/foundry/test', filePath);
    }
    if (filePath.endsWith('.s.sol')) {
      return path.join(buildState.projectPath, 'packages/foundry/script', filePath);
    }
    return path.join(buildState.projectPath, 'packages/foundry/contracts', filePath);
  }
  if (filePath.endsWith('.tsx') || filePath.endsWith('.ts')) {
    return path.join(buildState.projectPath, 'packages/nextjs', filePath);
  }

  return path.join(buildState.projectPath, filePath);
}

// --- Evaluation ---

async function evaluateStep(step, result, buildState) {
  // Quick checks for obvious failures
  if (result.exitCode && result.exitCode !== 0) {
    return {
      passed: false,
      reason: `Command failed with exit code ${result.exitCode}`,
      summary: result.output,
    };
  }

  // For gate steps, parse the LLM output
  if (step.gate) {
    const passed = /\bPASS\b/i.test(result.output);
    return {
      passed,
      reason: passed ? 'Gate passed' : result.output.slice(0, 500),
      summary: result.output,
    };
  }

  // Command steps that exit 0 are successful — no LLM needed
  if (isCommandStep(step) && result.exitCode === 0) {
    return {
      passed: true,
      reason: 'Command completed successfully',
      summary: `Exit code 0. ${(result.output || '').slice(-200)}`,
    };
  }

  // Read-agents step is pass/fail based on content
  if (step.name.includes('read-agents') && result.exitCode === 0) {
    return { passed: true, reason: 'AGENTS.md loaded', summary: result.output };
  }

  // For code steps, verify files were written
  if (isCodeStep(step) && result.files && result.files.length > 0) {
    const allExist = result.files.every(f => {
      const full = resolveFilePath(f, buildState);
      return full && fs.existsSync(full);
    });
    if (!allExist) {
      return {
        passed: false,
        reason: 'Not all expected files were written to disk',
        summary: `Expected: ${result.files.join(', ')}`,
      };
    }
    // Files exist — pass
    return {
      passed: true,
      reason: `All ${result.files.length} files written successfully`,
      summary: `Files: ${result.files.join(', ')}`,
    };
  }

  // Use minimax for evaluation only when we can't determine deterministically
  const evalResult = await callLLM('minimax',
    'You evaluate whether a build step succeeded. Output PASS or FAIL followed by a one-line reason.',
    `Step: ${step.name}\nExpected: ${step.evaluation}\nResult: ${(result.output || '').slice(0, 1000)}\nFiles written: ${(result.files || []).join(', ')}\n\nDid this step succeed? Output PASS or FAIL + reason.`,
    { maxTokens: 128, label: `eval-${step.name}` }
  );

  const passed = /\bPASS\b/i.test(evalResult);
  return {
    passed,
    reason: evalResult.replace(/^(PASS|FAIL):?\s*/i, ''),
    summary: evalResult,
  };
}

// --- State management ---

function updateBuildState(step, result, buildState) {
  // After scaffolding, set the project path
  if (step.name.includes('scaffold')) {
    // Find the created directory
    const buildDir = buildState.buildPath;
    const dirs = fs.readdirSync(buildDir).filter(d => {
      const full = path.join(buildDir, d);
      return fs.statSync(full).isDirectory() && d !== 'skills' && d !== 'step-logs';
    });
    if (dirs.length > 0) {
      buildState.projectPath = path.join(buildDir, dirs[dirs.length - 1]);
      log(`  Project path: ${buildState.projectPath}`);
    }
  }

  // After reading AGENTS.md, store its contents
  if (step.name.includes('read-agents')) {
    if (buildState.projectPath) {
      const agentsPath = path.join(buildState.projectPath, 'AGENTS.md');
      if (fs.existsSync(agentsPath)) {
        buildState.agentsMd = fs.readFileSync(agentsPath, 'utf-8');
        log(`  Loaded AGENTS.md (${buildState.agentsMd.length} chars)`);
      }
    }
  }
}

function gatherStateReport(buildState) {
  const lines = [];
  lines.push(`Project path: ${buildState.projectPath || 'not created'}`);
  lines.push(`AGENTS.md loaded: ${buildState.agentsMd ? 'yes' : 'no'}`);

  if (buildState.projectPath && fs.existsSync(buildState.projectPath)) {
    // Check key directories/files
    const checks = [
      'packages/foundry/contracts',
      'packages/foundry/test',
      'packages/foundry/script',
      'packages/nextjs/contracts/deployedContracts.ts',
      'packages/nextjs/app',
      'packages/nextjs/components',
    ];
    for (const check of checks) {
      const full = path.join(buildState.projectPath, check);
      const exists = fs.existsSync(full);
      if (exists && fs.statSync(full).isDirectory()) {
        try {
          const contents = fs.readdirSync(full);
          lines.push(`${check}: ${contents.join(', ')}`);
        } catch (e) {
          lines.push(`${check}: exists (unreadable)`);
        }
      } else {
        lines.push(`${check}: ${exists ? 'exists' : 'MISSING'}`);
      }
    }
  }

  return lines.join('\n');
}
