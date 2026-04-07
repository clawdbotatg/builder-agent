import path from 'path';
import { callLLM, MODELS, getRunLog, generateAuditMarkdown } from './llm.js';
import { writeFile, log } from './utils.js';

export async function generatePlan(buildPath, job, skills, messages) {
  log('=== PHASE 1: Extract requirements (minimax) ===');

  const jobContext = buildJobContext(job, messages);
  const requirementsPrompt = buildRequirementsPrompt(jobContext);

  const requirements = await callLLM('minimax',
    'You are a requirements analyst for Ethereum dApp builds. Extract structured requirements from job descriptions. Preserve EXACT contract names, function signatures, struct definitions, and page names from the job description. Do not rename or simplify anything.',
    requirementsPrompt,
    { maxTokens: 2048, label: 'extract-requirements' }
  );

  writeFile(path.join(buildPath, 'requirements.md'), requirements);
  log('  Saved requirements.md');

  log('=== PHASE 1.5: Condense skill docs for sonnet (minimax) ===');

  const condensed = await condenseSkillDocs(skills, requirements);
  writeFile(path.join(buildPath, 'condensed-skills.md'), condensed);
  log('  Saved condensed-skills.md');

  log('=== PHASE 2: Detailed build plan (sonnet) ===');

  const planPrompt = buildPlanPrompt(requirements, condensed, jobContext);

  const plan = await callLLM('sonnet',
    buildPlannerSystemPrompt(),
    planPrompt,
    { maxTokens: 4096, label: 'generate-build-plan' }
  );

  writeFile(path.join(buildPath, 'plan.md'), plan);
  log('  Saved plan.md');

  log('=== PHASE 3: Break into steps (minimax) ===');

  const stepsPrompt = buildStepsPrompt(plan, condensed);

  const stepsRaw = await callLLM('minimax',
    buildStepsSystemPrompt(),
    stepsPrompt,
    { maxTokens: 4096, label: 'break-into-steps' }
  );

  let steps;
  try {
    const jsonMatch = stepsRaw.match(/\[[\s\S]*\]/);
    steps = JSON.parse(jsonMatch ? jsonMatch[0] : stepsRaw);
  } catch (e) {
    log(`  ⚠ Failed to parse steps JSON, saving raw output`);
    steps = [{ error: 'Failed to parse', raw: stepsRaw }];
  }

  writeFile(path.join(buildPath, 'steps.json'), JSON.stringify(steps, null, 2));
  log('  Saved steps.json');

  // Save run log (JSON + human-readable audit)
  writeFile(path.join(buildPath, 'llm-log.json'), JSON.stringify(getRunLog(), null, 2));
  writeFile(path.join(buildPath, 'llm-audit.md'), generateAuditMarkdown());
  log('  Saved llm-log.json + llm-audit.md');

  return { requirements, plan, steps };
}

async function condenseSkillDocs(skills, requirements) {
  const condensed = [];

  for (const [filename, content] of Object.entries(skills)) {
    const summary = await callLLM('minimax',
      'You extract the most important rules, commands, and patterns from technical docs. Output only the essential information. Be concise but do not miss critical rules or commands.',
      `Extract the key rules, commands, and patterns from this skill doc that are relevant to building an Ethereum dApp. Focus on:
- Required commands and their exact syntax
- Critical rules that MUST be followed (security, patterns, conventions)
- Common mistakes to avoid
- Step-by-step procedures

Here are the requirements for context:
${requirements}

---

SKILL DOC (${filename}):
${content}

---

Output a condensed version (max 1500 chars) with only the essential information. Use bullet points.`,
      { maxTokens: 1024, label: `condense-${filename}` }
    );
    condensed.push(`### ${filename}\n${summary}\n`);
  }

  return condensed.join('\n');
}

function buildJobContext(job, messages) {
  let context = `## Job #${job.id}\n`;
  context += `- Service Type: ${job.serviceTypeId} (Build)\n`;
  context += `- Client: ${job.client}\n`;
  context += `- Status: ${job.status}\n\n`;
  context += `## Description\n${job.description}\n\n`;

  if (messages && messages.length > 0) {
    context += `## Job Chat\n`;
    for (const msg of messages) {
      context += `- [${msg.type || 'message'}]: ${msg.content}\n`;
    }
  }

  return context;
}

function buildRequirementsPrompt(jobContext) {
  return `Analyze this Ethereum dApp build job and extract structured requirements.

IMPORTANT: Preserve the EXACT names from the job description. If the job says "GuestBook.sol", use "GuestBook.sol" — do NOT rename it. If the job lists specific function signatures, copy them exactly.

${jobContext}

Output the following sections:
1. **App Summary** — One paragraph describing what this dApp does
2. **Contract Name & File** — Exact contract name and filename from the job description
3. **Storage** — Exact struct definitions, arrays, and mappings as specified
4. **Functions** — Every function listed in the job, with exact signatures
5. **Events** — What events to emit (one per state change minimum)
6. **Access Control** — Who can call what
7. **Target Chain** — Which chain to deploy to (default: Base)
8. **Frontend Pages** — Every page/view listed in the job description, with exact names
9. **User Flows** — Key interactions step by step
10. **Integrations** — ENS, Blockscout, etc. as specified
11. **Security Notes** — From the job description`;
}

function buildPlannerSystemPrompt() {
  return `You are a senior Ethereum dApp architect planning a build using Scaffold-ETH 2 (SE2) with Foundry.

CRITICAL SE2 RULES — violating these will break the build:

EDITING IN PLACE (CRITICAL):
- SE2 scaffold creates default files (YourContract.sol, DeployYourContract.s.sol, YourContract.t.sol, app/page.tsx).
  You MUST replace these with your own code. Do NOT leave unused default scaffold files.
- Deploy scripts: Edit \`DeployYourContract.s.sol\` (or create new and delete it). MUST use \`ScaffoldETHDeploy\` base
  class and \`ScaffoldEthDeployerRunner\` modifier from \`DeployHelpers.s.sol\`. Also update \`Deploy.s.sol\` to reference your contract.
- Home page: Edit \`packages/nextjs/app/page.tsx\` — this is the App Router home page.

FRONTEND:
- SE2 uses Next.js APP ROUTER — pages are in \`packages/nextjs/app/\`, NOT \`pages/\`.
  Home = \`app/page.tsx\`, dynamic routes = \`app/signer/[address]/page.tsx\`.
- Add \`"use client"\` at top of every page/component that uses React hooks.
- Import UI components from \`@scaffold-ui/components\`: Address, AddressInput, Balance, EtherInput.
- Use \`useScaffoldReadContract\` and \`useScaffoldWriteContract\` DIRECTLY — NO wrapper hooks.
- Hook names: useScaffoldReadContract (NOT useScaffoldContractRead), useScaffoldWriteContract (NOT useScaffoldContractWrite).
- Use \`useScaffoldEventHistory\` for reading events.
- \`deployedContracts.ts\` is AUTO-GENERATED by \`yarn deploy\`. NEVER edit it manually.
- RainbowKit handles wallet connection and network switching — do NOT build custom components for this.
- Use DaisyUI classes for styling, not raw Tailwind when DaisyUI has a component.
- Use \`notification\` from \`~~/utils/scaffold-eth\` for user feedback.
- Use \`~~\` path alias for all imports within the nextjs package.

BUILD PRINCIPLES:
- Preserve EXACT names from the job description. If the job says GuestBook.sol, the contract MUST be named GuestBook.sol.
- Checks-Effects-Interactions pattern for all state changes.
- Emit events for every state change.
- If contract has no owner/admin (hyperstructure), do NOT add Ownable or access control.
- Three-phase build: Phase 1 (fork + contracts + UI on localhost), Phase 2 (live contracts + local UI), Phase 3 (IPFS deploy via bgipfs).
- NEVER commit secrets. Use .env files.

Your plan must use the exact contract names, function signatures, struct definitions, and page names from the job description. Do not rename anything.`;
}

function buildPlanPrompt(requirements, condensedSkills, jobContext) {
  return `Create a detailed build plan for this Ethereum dApp.

## Requirements
${requirements}

## Job Context
${jobContext}

## Key Rules from Skill Docs
${condensedSkills}

---

Write a comprehensive build plan with these sections:

# Build Plan for Job #[ID]

## 1. Architecture Overview
- What goes onchain vs offchain
- Contract diagram (text-based)
- Data flow using SE2 scaffold hooks (useScaffoldReadContract, useScaffoldWriteContract)

## 2. Smart Contracts
- Use the EXACT contract name from the job description
- For each contract: name, file path, all functions with exact signatures from the job
- Storage: exact struct definitions and mappings from the job
- Events to emit
- Access control
- Security considerations

## 3. Frontend
- Pages with exact names from the job description
- Components needed (use SE2 built-in components where possible: <Address/>, <Balance/>, etc.)
- Do NOT create wrapper hooks — use useScaffoldReadContract/useScaffoldWriteContract directly in components
- User flows (network switch handled by RainbowKit automatically)

## 4. Three-Phase Build Plan

### Phase 1: Local Development
- Scaffold command: \`npx -y create-eth@latest -s foundry <project-name>\`
- Read AGENTS.md (mandatory before writing any code)
- Start fork: \`yarn fork --network base\`
- Contract implementation (exact file paths)
- Deploy script (in packages/foundry/script/, snake_case filename)
- Deploy: \`yarn deploy\` (auto-generates deployedContracts.ts)
- Tests (unit + edge cases)
- Frontend components using scaffold hooks directly
- Start UI: \`yarn start\`

### Phase 2: Live Contracts + Local UI
- Deploy to Base: \`yarn deploy --network base\`
- Verify on Blockscout
- Update scaffold.config.ts targetNetworks
- Test with real wallet

### Phase 3: Production Deploy
- IPFS build: rm -rf .next out, NEXT_PUBLIC_IPFS_BUILD=true, polyfill
- bgipfs upload
- Verify on gateway URL

## 5. Security Checklist

## 6. Evaluation Criteria`;
}

function buildStepsSystemPrompt() {
  return `You are a project manager breaking a build plan into steps. You follow the ethskills.com orchestration pipeline EXACTLY.

MODEL ASSIGNMENT RULES:
- "minimax" — shell commands, boilerplate, deploy scripts, simple components, config, validation checks
- "sonnet" — tests, complex frontend components, code review, evaluation, security audit
- "opus" — smart contract Solidity code ONLY

SE2 ANTI-PATTERNS — NEVER include these:
- Wrapper hooks around scaffold hooks
- Custom NetworkGuard/wallet connect components
- Raw wagmi hooks
- Editing deployedContracts.ts

MANDATORY PHASE STRUCTURE (from ethskills.com/orchestration/SKILL.md):

=== PHASE 1: LOCAL DEVELOPMENT ===
Steps MUST be in this order:
1. Scaffold: npx -y create-eth@latest -s foundry <name>
2. Read AGENTS.md (context for all subsequent steps)
3. Start fork: yarn fork --network base (NOT yarn chain)
4. Write smart contract(s) in packages/foundry/contracts/ (opus)
5. Write deploy script in packages/foundry/script/ (minimax)
6. Deploy locally: yarn deploy (minimax) — auto-generates deployedContracts.ts
7. Write tests in packages/foundry/test/ — target ≥90% coverage (sonnet)
8. Run tests: forge test (minimax)
9. VALIDATION GATE: yarn deploy succeeds, deployedContracts.ts exists, all tests pass
10. Build frontend components using scaffold hooks DIRECTLY (no wrapper hooks)
11. Build pages
12. Start frontend: yarn start
13. VALIDATION GATE: complete user journey works on localhost

=== PHASE 2: LIVE CONTRACTS + LOCAL UI ===
14. Update scaffold.config.ts targetNetworks to Base
15. Fund deployer wallet
16. Deploy to Base: yarn deploy --network base
17. Verify on Blockscout: yarn verify --network base
18. Test with real wallet (small amounts $1-10)
19. VALIDATION GATE: contracts verified, user journey works on live chain

=== PHASE 3: PRODUCTION ===
20. Set burnerWalletMode: "localNetworksOnly" in scaffold.config.ts
21. Update metadata (title, description, OG image)
22. IPFS build: rm -rf .next out, NEXT_PUBLIC_IPFS_BUILD=true, polyfill-localstorage.cjs
23. Upload to IPFS via bgipfs
24. VALIDATION GATE: dApp loads and works at IPFS gateway URL

Include validation gate steps as real steps with model "sonnet" (evaluation).

Output ONLY a JSON array. No markdown fences. No commentary.`;
}

function buildStepsPrompt(plan, condensedSkills) {
  return `Break this build plan into steps following the ethskills orchestration pipeline.

## Build Plan
${plan}

## SE2 Reference
${condensedSkills}

For each step, output a JSON object with:
- "step": step number (integer)
- "phase": "1-local", "2-live", or "3-production"
- "name": short kebab-case name
- "description": what to do in 1-2 sentences. Include the exact command to run if applicable.
- "model": "minimax", "sonnet", or "opus" (see system prompt rules)
- "inputs": array of strings — context/files needed
- "outputs": array of strings — files/artifacts produced
- "evaluation": how to verify success
- "gate": true if this is a validation gate step, false otherwise

Rules:
- Follow the EXACT phase ordering from the system prompt
- Include validation gate steps between phases
- Smart contracts → opus
- Tests, security audit, validation gates → sonnet
- Everything else → minimax
- Use scaffold hooks directly in components (NO wrapper hooks)
- Include exact commands where applicable (yarn fork, yarn deploy, forge test, etc.)

Output ONLY a JSON array.`;
}
