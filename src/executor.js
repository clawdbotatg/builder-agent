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

    try {
      // 1. CONTEXT — minimax prepares the prompt
      log(`  Preparing context...`);
      const { systemPrompt, userPrompt } = await prepareStepContext(step, buildState);

      writeFile(path.join(stepDir, 'system-prompt.md'), systemPrompt);
      writeFile(path.join(stepDir, 'user-prompt.md'), userPrompt);

      // 2. EXECUTE — call the target model or run commands
      let result;

      if (step.name === 'read-agents-md' || step.name === 'read-agents') {
        // Special step: read AGENTS.md and store in build state
        result = await executeReadAgentsStep(step, buildState);
      } else if (isCommandStep(step)) {
        // Shell command steps — extract and run the command
        result = await executeCommandStep(step, buildState, systemPrompt, userPrompt);
      } else if (step.gate) {
        // Validation gate — evaluate current state
        result = await executeGateStep(step, buildState, systemPrompt, userPrompt);
      } else if (isCodeStep(step)) {
        // Code generation steps — call LLM and write files
        result = await executeCodeStep(step, buildState, systemPrompt, userPrompt);
      } else {
        // Generic step — call LLM for guidance/output
        result = await executeGenericStep(step, buildState, systemPrompt, userPrompt);
      }

      writeFile(path.join(stepDir, 'result.md'), result.output || 'No output');
      if (result.files) {
        writeFile(path.join(stepDir, 'files-written.json'), JSON.stringify(result.files, null, 2));
      }

      // 3. EVALUATE — check if step succeeded
      log(`  Evaluating...`);
      const evaluation = await evaluateStep(step, result, buildState);
      writeFile(path.join(stepDir, 'evaluation.md'), evaluation.summary);

      // 4. UPDATE STATE — always update state (e.g., set projectPath after scaffold)
      // even if evaluation fails, so subsequent steps can reference the project
      updateBuildState(step, result, buildState);

      if (!evaluation.passed) {
        log(`  ✗ FAILED: ${evaluation.reason}`);
        writeFile(path.join(stepDir, 'FAILED.md'), evaluation.reason);
        // For now, log and continue. Later: retry logic.
        buildState.completedSteps.push({
          ...step,
          result: `FAILED: ${evaluation.reason}`,
        });
        continue;
      }

      log(`  ✓ PASSED`);

      buildState.completedSteps.push({
        ...step,
        result: 'done',
      });

    } catch (err) {
      log(`  ✗ ERROR: ${err.message}`);
      writeFile(path.join(stepDir, 'ERROR.md'), err.stack || err.message);
      buildState.completedSteps.push({
        ...step,
        result: `ERROR: ${err.message}`,
      });
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
    return runCommand(response.trim(), buildState);
  }

  // Longer timeout for scaffold/install
  const timeout = (step.name.includes('scaffold') || step.name.includes('install')) ? 300_000 : 120_000;
  return runCommand(command, buildState, { timeout });
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
    // Extract deploy file from step description if specified
    const fileMatch = step.description && step.description.match(/--file\s+(\S+)/);
    const fileArg = fileMatch ? ` --file ${fileMatch[1]}` : '';
    return projectDir ? `cd "${projectDir}" && yarn deploy${fileArg}` : null;
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

  // For long-running commands like fork, we'd need background execution.
  // For now, skip background commands and just note them.
  if (command.includes('yarn fork') || command.includes('yarn start')) {
    log(`  ⚠ Background command — noting for manual execution`);
    return {
      output: `Background command (run manually): ${command}`,
      exitCode: 0,
      files: [],
    };
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

async function executeCodeStep(step, buildState, systemPrompt, userPrompt) {
  // Call the target model to generate code
  const maxTokens = step.model === 'opus' ? 8192 : step.model === 'sonnet' ? 8192 : 2048;

  // Append output format instruction to user prompt
  const formatInstruction = `\n\nIMPORTANT: For each file you produce, use this exact format:\n\nFILE: path/to/file.ext\n\`\`\`lang\n<file content>\n\`\`\`\n\nUse the full relative path (e.g., packages/foundry/contracts/GuestBook.sol).`;

  const response = await callLLM(step.model,
    systemPrompt,
    userPrompt + formatInstruction,
    { maxTokens, label: `code-${step.name}` }
  );

  // Parse code blocks and file paths from the response
  const files = extractFilesFromResponse(response, step, buildState);

  // Write files to disk
  for (const file of files) {
    const fullPath = resolveFilePath(file.path, buildState);
    if (fullPath) {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, file.content, 'utf-8');
      log(`  Wrote: ${file.path}`);
    }
  }

  return { output: response, files: files.map(f => f.path) };
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
    const blockRegex = /```(?:solidity|typescript|tsx|javascript|js|ts|cjs)\n([\s\S]*?)```/g;
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

  // If it's just a filename, try to place it intelligently
  if (filePath.endsWith('.sol') && !filePath.includes('/')) {
    return path.join(buildState.projectPath, 'packages/foundry/contracts', filePath);
  }
  if (filePath.endsWith('.t.sol')) {
    return path.join(buildState.projectPath, 'packages/foundry/test', filePath);
  }
  if (filePath.endsWith('.s.sol')) {
    return path.join(buildState.projectPath, 'packages/foundry/script', filePath);
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
