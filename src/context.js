import fs from 'fs';
import path from 'path';
import { callLLM } from './llm.js';
import { log } from './utils.js';

// Pre-built context rules per step type.
// These map step names/patterns to which skill docs and what focus areas matter.
// This avoids calling minimax to "figure out" what context to include — we KNOW.
const STEP_CONTEXT_MAP = {
  'scaffold': {
    skills: ['scaffold-eth.md', 'agents-md.md'],
    focus: 'project-setup',
    projectFiles: [],
  },
  'read-agents': {
    skills: ['agents-md.md'],
    focus: 'conventions',
    projectFiles: ['AGENTS.md'],
  },
  'write-*-contract': {
    skills: ['ethskills.md', 'ship.md', 'agents-md.md'],
    focus: 'solidity',
    projectFiles: [],
  },
  'write-deploy': {
    skills: ['agents-md.md'],
    focus: 'deploy-script',
    projectFiles: [],
  },
  'write-*-test': {
    skills: ['ethskills.md', 'agents-md.md'],
    focus: 'testing',
    projectFiles: [],
  },
  'build-*-page': {
    skills: ['agents-md.md', 'orchestration.md', 'ethskills.md'],
    focus: 'frontend',
    projectFiles: [],
  },
  'build-*': {
    skills: ['agents-md.md', 'orchestration.md'],
    focus: 'frontend',
    projectFiles: [],
  },
  'deploy-to-*': {
    skills: ['orchestration.md', 'agents-md.md'],
    focus: 'deploy-command',
    projectFiles: [],
  },
  'build-for-ipfs': {
    skills: ['bgipfs.md', 'orchestration.md'],
    focus: 'ipfs-deploy',
    projectFiles: [],
  },
  'upload-to-ipfs': {
    skills: ['bgipfs.md'],
    focus: 'ipfs-deploy',
    projectFiles: [],
  },
  'validation-gate-*': {
    skills: ['orchestration.md'],
    focus: 'validation',
    projectFiles: [],
  },
};

// Focus-specific rules that get injected into prompts.
// These are the distilled, non-negotiable rules for each focus area.
const FOCUS_RULES = {
  'project-setup': `
- Run: npx -y create-eth@latest -s foundry <project-name>
- Default to Foundry if no preference
- Use kebab-case for project names
- After scaffold completes, AGENTS.md is the source of truth
- Do NOT proceed until scaffold is done and directory exists`,

  'conventions': `
- Read AGENTS.md completely before writing any code
- Hook names: useScaffoldReadContract (NOT useScaffoldContractRead)
- Hook names: useScaffoldWriteContract (NOT useScaffoldContractWrite)
- deployedContracts.ts is AUTO-GENERATED — never edit
- Use ~~ path alias for imports in nextjs package
- Use DaisyUI classes, not raw Tailwind
- Use notification from ~~/utils/scaffold-eth for feedback
- Deploy scripts use snake_case filenames
- SE2 built-in components: <Address/>, <AddressInput/>, <Balance/>, <EtherInput/>`,

  'solidity': `
- EDIT IN PLACE: Replace content of packages/foundry/contracts/YourContract.sol with your new contract
  OR create a new .sol file and DELETE YourContract.sol — do NOT leave unused scaffold files
- Follow Checks-Effects-Interactions pattern for ALL functions
- Emit events for EVERY state change
- Use OpenZeppelin base contracts when applicable
- If the job says no owner/admin, do NOT add Ownable
- Preserve EXACT function signatures from the job description
- Use calldata for string/bytes parameters in external functions
- Solidity ^0.8.20 for built-in overflow protection
- NEVER use tx.origin for authentication
- Paginate array reads — never return unbounded arrays`,

  'deploy-script': `
- MUST output TWO files: DeployGuestBook.s.sol AND Deploy.s.sol
- MUST use ScaffoldETHDeploy base class and ScaffoldEthDeployerRunner modifier from DeployHelpers.s.sol
- Use RELATIVE import paths: "../contracts/GuestBook.sol" and "./DeployHelpers.s.sol"
- The deployer variable and deployments array come from ScaffoldETHDeploy base class
- Do NOT use console.log — it requires a separate import and is not needed
- yarn deploy auto-generates deployedContracts.ts — NEVER edit that file

EXACT DeployGuestBook.s.sol (copy VERBATIM — do NOT add console.log, do NOT use named imports):
  // SPDX-License-Identifier: MIT
  pragma solidity ^0.8.19;
  import "./DeployHelpers.s.sol";
  import "../contracts/GuestBook.sol";
  contract DeployGuestBook is ScaffoldETHDeploy {
    function run() external ScaffoldEthDeployerRunner {
      GuestBook guestBook = new GuestBook();
      deployments.push(Deployment("GuestBook", address(guestBook)));
    }
  }
IMPORTANT: Use "import ./DeployHelpers.s.sol" (file import, NOT named import). Deployment struct and deployments array are inherited from ScaffoldETHDeploy.

EXACT Deploy.s.sol pattern (copy this structure):
  // SPDX-License-Identifier: MIT
  pragma solidity ^0.8.19;
  import "./DeployHelpers.s.sol";
  import { DeployGuestBook } from "./DeployGuestBook.s.sol";
  contract DeployScript is ScaffoldETHDeploy {
    function run() external {
      DeployGuestBook deployGuestBook = new DeployGuestBook();
      deployGuestBook.run();
    }
  }`,

  'testing': `
- EDIT IN PLACE: Replace packages/foundry/test/YourContract.t.sol with your test file
  OR create a new test file and DELETE YourContract.t.sol
- Use forge-std/Test.sol base
- Test every function in the contract
- Test edge cases: empty input, max length, zero index, out of bounds
- Test access control (or lack thereof)
- Fuzz test any math or variable-length inputs
- Use makeAddr() for test addresses
- Use vm.prank() to test different callers
- Aim for ≥90% coverage
- Run with: forge test`,

  'frontend': `
- CRITICAL: SE2 uses Next.js APP ROUTER, not Pages Router
- Pages go in packages/nextjs/app/ — e.g. app/page.tsx (home), app/signer/[address]/page.tsx
- EDIT IN PLACE: Replace content of app/page.tsx for the home page — do NOT create pages/index.tsx
- Add "use client" directive at top of every page/component that uses hooks
- Use scaffold hooks DIRECTLY in components — NO wrapper hooks
- useScaffoldReadContract({ contractName: "GuestBook", functionName: "getEntries", args: [...] })
- const { writeContractAsync, isPending } = useScaffoldWriteContract({ contractName: "GuestBook" })
- useScaffoldEventHistory({ contractName, eventName, fromBlock, watch })
- Import UI components from @scaffold-ui/components: Address, AddressInput, Balance, EtherInput
  Example: import { Address } from "@scaffold-ui/components";
- Use notification from ~~/utils/scaffold-eth for success/error feedback
- Use DaisyUI component classes for styling (btn, card, modal, etc.)
- Every action button needs its own loading + disabled state
- RainbowKit handles wallet connection and network switching — do NOT build custom wallet/network components
- Pages use NextPage type: import type { NextPage } from "next";
- Use ~~ path alias for all imports within nextjs package
- Put reusable components in packages/nextjs/components/ (NOT app/_components/)`,

  'deploy-command': `
- Phase 2: yarn deploy --network base
- Verify: yarn verify --network base
- Fund deployer first: yarn generate → yarn account → send ETH
- Update scaffold.config.ts targetNetworks before deploying`,

  'ipfs-deploy': `
- ALWAYS clean first: rm -rf .next out
- Build: NEXT_PUBLIC_IPFS_BUILD=true NODE_OPTIONS="--require ./polyfill-localstorage.cjs" npm run build
- The polyfill-localstorage.cjs file MUST exist in packages/nextjs/
- Upload: bgipfs upload packages/nextjs/out --config ~/.bgipfs/credentials.json
- Auth uses X-API-Key header, NOT Authorization: Bearer
- Access at: https://{CID}.ipfs.community.bgipfs.com/
- trailingSlash: true is CRITICAL — without it, routes return 404`,

  'validation': `
- Check that all files exist that should exist
- Run yarn deploy if needed to verify contracts compile and deploy
- Run forge test to verify tests pass
- Check deployedContracts.ts was generated
- For frontend: verify pages load, wallet connects, transactions work
- For production: verify IPFS gateway URL loads the dApp`,
};

/**
 * Prepare context for a step's executing model.
 * Returns { systemPrompt, userPrompt } ready to send to the LLM.
 */
export async function prepareStepContext(step, buildState) {
  const { skills, job, projectPath, completedSteps, agentsMd } = buildState;

  // 1. Match step to context map
  const contextConfig = matchStepConfig(step.name);
  const focusRules = FOCUS_RULES[contextConfig.focus] || '';

  // 2. Gather relevant skill excerpts
  const relevantSkills = contextConfig.skills
    .map(name => skills[name] ? `### ${name}\n${skills[name]}` : '')
    .filter(Boolean)
    .join('\n\n');

  // 3. Gather project files this step needs to see
  const projectFileContents = gatherProjectFiles(step, projectPath, completedSteps);

  // 4. Use minimax to write a focused prompt for the target model
  const contextPrompt = await callLLM('minimax',
    `You write focused, complete prompts for AI models that build Ethereum dApps with Scaffold-ETH 2.
Your job is to take a step definition, skill rules, and project context, then produce a SYSTEM PROMPT and USER PROMPT for the model that will execute the step.

The system prompt must include ALL relevant rules so the executing model cannot go off-rails.
The user prompt must be specific and actionable — tell the model EXACTLY what to produce.

CRITICAL: For code-producing steps, the USER PROMPT must end with this instruction:
"For each file, use this exact format: FILE: path/to/file.ext followed by a code block."

Output format (use these exact headers):
=== SYSTEM PROMPT ===
(rules and conventions the model must follow)

=== USER PROMPT ===
(specific task with all needed context)`,

    `Prepare prompts for step ${step.step}: "${step.name}"

## Step Definition
${JSON.stringify(step, null, 2)}

## Focus Rules (MUST include in system prompt)
${focusRules}

## Job Description
${buildState.job.description}

## Relevant Skill Rules
${relevantSkills}

## AGENTS.md Conventions (include relevant parts in system prompt)
${agentsMd || 'Not yet available — project not scaffolded yet'}

## Project Files Available
${projectFileContents || 'None yet — project not started'}

## Previous Steps Completed
${completedSteps.map(s => `${s.step}. ${s.name}: ${s.result || 'done'}`).join('\n') || 'None'}

---

Write the SYSTEM PROMPT and USER PROMPT. The system prompt should be comprehensive but focused.
The user prompt should tell the model exactly what file(s) to produce or what command to run.
Include exact file paths, function signatures, and patterns.`,
    { maxTokens: 2048, label: `context-step-${step.step}-${step.name}` }
  );

  // 5. Parse the output into system/user prompts
  return parseContextOutput(contextPrompt, step, focusRules);
}

function matchStepConfig(stepName) {
  // Try exact match first
  if (STEP_CONTEXT_MAP[stepName]) return STEP_CONTEXT_MAP[stepName];

  // Try wildcard patterns
  for (const [pattern, config] of Object.entries(STEP_CONTEXT_MAP)) {
    if (pattern.includes('*')) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      if (regex.test(stepName)) return config;
    }
  }

  // Default: include core skills
  return {
    skills: ['agents-md.md', 'orchestration.md'],
    focus: 'conventions',
    projectFiles: [],
  };
}

function gatherProjectFiles(step, projectPath, completedSteps) {
  if (!projectPath || !fs.existsSync(projectPath)) return '';

  const files = [];

  // Always include contract source if it exists and step needs it
  const contractsDir = path.join(projectPath, 'packages/foundry/contracts');
  if (fs.existsSync(contractsDir)) {
    try {
      const solFiles = fs.readdirSync(contractsDir).filter(f => f.endsWith('.sol') && f !== 'YourContract.sol');
      for (const f of solFiles) {
        const content = fs.readFileSync(path.join(contractsDir, f), 'utf-8');
        files.push(`### ${f}\n\`\`\`solidity\n${content}\n\`\`\``);
      }
    } catch (e) { /* skip */ }
  }

  // Include Deploy.s.sol and DeployHelpers.s.sol when writing deploy scripts
  if (step.name.includes('deploy') && !step.name.includes('deploy-to')) {
    for (const scriptFile of ['Deploy.s.sol', 'DeployHelpers.s.sol']) {
      const scriptPath = path.join(projectPath, 'packages/foundry/script', scriptFile);
      if (fs.existsSync(scriptPath)) {
        try {
          const content = fs.readFileSync(scriptPath, 'utf-8');
          files.push(`### ${scriptFile} (EXISTING — you must update Deploy.s.sol to reference your contract)\n\`\`\`solidity\n${content}\n\`\`\``);
        } catch (e) { /* skip */ }
      }
    }
  }

  // Include deployedContracts.ts if frontend step
  if (step.name.includes('build-') || step.name.includes('page') || step.name.includes('styling')) {
    const deployed = path.join(projectPath, 'packages/nextjs/contracts/deployedContracts.ts');
    if (fs.existsSync(deployed)) {
      try {
        const content = fs.readFileSync(deployed, 'utf-8');
        files.push(`### deployedContracts.ts (AUTO-GENERATED — shows ABI, do NOT edit)\n\`\`\`typescript\n${content}\n\`\`\``);
      } catch (e) { /* skip */ }
    }
  }

  // Include existing app/page.tsx and components for frontend steps
  if (step.name.includes('build-') || step.name.includes('page') || step.name.includes('styling')) {
    // Current home page (to edit in place)
    const homePage = path.join(projectPath, 'packages/nextjs/app/page.tsx');
    if (fs.existsSync(homePage)) {
      try {
        const content = fs.readFileSync(homePage, 'utf-8');
        files.push(`### app/page.tsx (CURRENT — edit this file for the home page)\n\`\`\`tsx\n${content}\n\`\`\``);
      } catch (e) { /* skip */ }
    }

    // Existing custom components
    const componentsDir = path.join(projectPath, 'packages/nextjs/components');
    if (fs.existsSync(componentsDir)) {
      try {
        const tsxFiles = fs.readdirSync(componentsDir).filter(f =>
          f.endsWith('.tsx') && !['Header.tsx', 'Footer.tsx', 'SwitchTheme.tsx', 'ThemeProvider.tsx', 'ScaffoldEthAppWithProviders.tsx'].includes(f)
        );
        for (const f of tsxFiles) {
          const content = fs.readFileSync(path.join(componentsDir, f), 'utf-8');
          files.push(`### components/${f}\n\`\`\`tsx\n${content}\n\`\`\``);
        }
      } catch (e) { /* skip */ }
    }
  }

  return files.join('\n\n');
}

function parseContextOutput(raw, step, fallbackRules) {
  const sysMatch = raw.match(/===\s*SYSTEM PROMPT\s*===\s*([\s\S]*?)(?====\s*USER PROMPT|$)/i);
  const userMatch = raw.match(/===\s*USER PROMPT\s*===\s*([\s\S]*?)$/i);

  const systemPrompt = sysMatch ? sysMatch[1].trim() : `You are building an Ethereum dApp with Scaffold-ETH 2.\n\n${fallbackRules}`;
  const userPrompt = userMatch ? userMatch[1].trim() : `Execute step ${step.step}: ${step.description}`;

  return { systemPrompt, userPrompt };
}
