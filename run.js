#!/usr/bin/env node
import 'dotenv/config';
import { program } from 'commander';
import path from 'path';
import { createBuildFolder, writeFile, log } from './src/utils.js';
import { fetchSkillDocs, fetchJob, fetchJobMessages } from './src/fetcher.js';
import { generatePlan, } from './src/planner.js';
import { resetRunLog } from './src/llm.js';

program
  .option('--job <id>', 'Job ID to build', '39')
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

  // 5. Generate build plan
  const result = await generatePlan(buildPath, job, skills, messages);

  // 6. Summary
  log(`========================================`);
  log(`BUILD PLAN COMPLETE`);
  log(`  Folder: builds/${path.basename(buildPath)}`);
  log(`  Plan: plan.md (${result.plan.length} chars)`);
  log(`  Steps: ${Array.isArray(result.steps) ? result.steps.length : '?'} steps`);
  log(`========================================`);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
