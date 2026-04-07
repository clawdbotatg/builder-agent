#!/usr/bin/env node
import 'dotenv/config';
import { program } from 'commander';
import fs from 'fs';
import path from 'path';
import { createBuildFolder, writeFile, log } from './src/utils.js';
import { fetchSkillDocs, fetchJob, fetchJobMessages } from './src/fetcher.js';
import { generatePlan, } from './src/planner.js';
import { executeSteps } from './src/executor.js';
import { resetRunLog, getRunLog, generateAuditMarkdown } from './src/llm.js';

program
  .option('--job <id>', 'Job ID to build', '39')
  .option('--execute', 'Execute the build plan after generating it')
  .option('--plan-only', 'Only generate the plan, skip execution (default)')
  .option('--steps <range>', 'Execute only specific steps, e.g. "1-5" or "1,3,5"')
  .option('--reuse <folder>', 'Reuse plan from an existing build folder (skip planning)')
  .parse();

const opts = program.opts();
const jobId = parseInt(opts.job, 10);

async function main() {
  log(`========================================`);
  log(`Builder Agent — Job #${jobId}`);
  log(`========================================`);

  // Reset LLM log for this run
  resetRunLog();

  // 1. Create build folder
  const buildPath = createBuildFolder(jobId);
  log(`Build folder: ${path.basename(buildPath)}`);

  // 2. Fetch job data
  const job = await fetchJob(jobId);
  writeFile(path.join(buildPath, 'job.json'), JSON.stringify(job, null, 2));

  // 3. Fetch job messages/chat
  const messages = await fetchJobMessages(jobId);
  if (messages.length > 0) {
    writeFile(path.join(buildPath, 'messages.json'), JSON.stringify(messages, null, 2));
  }

  // 4. Fetch skill docs
  const skills = await fetchSkillDocs(buildPath);
  log(`Fetched ${Object.keys(skills).length} skill docs`);

  // 5. Generate build plan (or reuse existing one)
  let result;
  if (opts.reuse) {
    const reusePath = path.resolve('builds', opts.reuse);
    const stepsJson = fs.readFileSync(path.join(reusePath, 'steps.json'), 'utf-8');
    const planMd = fs.readFileSync(path.join(reusePath, 'plan.md'), 'utf-8');
    result = { plan: planMd, steps: JSON.parse(stepsJson) };
    // Copy plan files to new build folder
    writeFile(path.join(buildPath, 'plan.md'), planMd);
    writeFile(path.join(buildPath, 'steps.json'), stepsJson);
    log(`Reusing plan from ${opts.reuse} (${result.steps.length} steps)`);
  } else {
    result = await generatePlan(buildPath, job, skills, messages);
  }

  log(`========================================`);
  log(`BUILD PLAN COMPLETE`);
  log(`  Folder: builds/${path.basename(buildPath)}`);
  log(`  Plan: plan.md (${result.plan.length} chars)`);
  log(`  Steps: ${Array.isArray(result.steps) ? result.steps.length : '?'} steps`);
  log(`========================================`);

  // 6. Execute steps if requested
  if (opts.execute && Array.isArray(result.steps)) {
    let stepsToRun = result.steps;

    // Filter steps if --steps flag is provided
    if (opts.steps) {
      const stepNums = parseStepRange(opts.steps);
      stepsToRun = result.steps.filter(s => stepNums.includes(s.step));
      log(`Running ${stepsToRun.length} of ${result.steps.length} steps: ${stepNums.join(', ')}`);
    }

    log(`\n========================================`);
    log(`EXECUTING BUILD PLAN (${stepsToRun.length} steps)`);
    log(`========================================\n`);

    // Build condensed skills map for the executor
    const condensedSkills = {};
    for (const [name, content] of Object.entries(skills)) {
      condensedSkills[name] = content;
    }

    const buildState = await executeSteps(stepsToRun, buildPath, job, condensedSkills);

    // Save final audit log
    writeFile(path.join(buildPath, 'llm-log.json'), JSON.stringify(getRunLog(), null, 2));
    writeFile(path.join(buildPath, 'llm-audit.md'), generateAuditMarkdown());

    const passed = buildState.completedSteps.filter(s => s.result === 'done').length;
    const failed = buildState.completedSteps.filter(s => s.result !== 'done').length;

    log(`\n========================================`);
    log(`EXECUTION COMPLETE`);
    log(`  Passed: ${passed}/${buildState.completedSteps.length}`);
    log(`  Failed: ${failed}`);
    log(`  Project: ${buildState.projectPath || 'not created'}`);
    log(`========================================`);
  }
}

function parseStepRange(rangeStr) {
  const nums = [];
  for (const part of rangeStr.split(',')) {
    if (part.includes('-')) {
      const [start, end] = part.split('-').map(Number);
      for (let i = start; i <= end; i++) nums.push(i);
    } else {
      nums.push(Number(part));
    }
  }
  return nums;
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
