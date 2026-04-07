import { execSync } from 'child_process';
import path from 'path';
import { writeFile, log } from './utils.js';

const CONTRACT_ADDRESS = '0xb2fb486a9569ad2c97d9c73936b46ef7fdaa413a';

const SKILL_URLS = {
  'ethskills.md': 'https://ethskills.com/SKILL.md',
  'ship.md': 'https://ethskills.com/ship/SKILL.md',
  'orchestration.md': 'https://ethskills.com/orchestration/SKILL.md',
  'scaffold-eth.md': 'https://docs.scaffoldeth.io/SKILL.md',
  'agents-md.md': 'https://raw.githubusercontent.com/scaffold-eth/scaffold-eth-2/main/AGENTS.md',
  'bgipfs.md': 'https://www.bgipfs.com/SKILL.md',
};

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
  return response.text();
}

export async function fetchSkillDocs(buildPath) {
  log('Fetching skill docs...');
  const skills = {};

  const entries = Object.entries(SKILL_URLS);
  const results = await Promise.allSettled(
    entries.map(async ([filename, url]) => {
      const content = await fetchText(url);
      return { filename, content };
    })
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      const { filename, content } = result.value;
      skills[filename] = content;
      writeFile(path.join(buildPath, 'skills', filename), content);
      log(`  ✓ ${filename} (${content.length} chars)`);
    } else {
      log(`  ✗ Failed: ${result.reason.message}`);
    }
  }

  return skills;
}

export async function fetchJob(jobId) {
  log(`Fetching job ${jobId} from smart contract...`);

  const rpcUrl = process.env.BASE_RPC_URL;
  if (!rpcUrl) throw new Error('BASE_RPC_URL not set in .env');

  // ABI struct: (uint256 id, address client, uint256 serviceTypeId, uint256 paymentClawd,
  //   uint256 priceUsd, string description, uint8 status, uint256 createdAt,
  //   uint256 startedAt, uint256 completedAt, string resultCID, address worker,
  //   bool paymentClaimed, uint8 paymentMethod, uint256 cvAmount, string currentStage)
  const SIG = 'getJob(uint256)((uint256,address,uint256,uint256,uint256,string,uint8,uint256,uint256,uint256,string,address,bool,uint8,uint256,string))';

  try {
    const raw = execSync(
      `cast call ${CONTRACT_ADDRESS} "${SIG}" ${jobId} --rpc-url "${rpcUrl}"`,
      { encoding: 'utf-8', timeout: 15000 }
    ).trim();

    // cast outputs the tuple as: (field1, field2, ..., "string field", ...)
    // Parse the key fields from the decoded output
    const job = parseCastTupleOutput(raw, jobId);
    log(`  ✓ Job ${jobId} fetched from contract`);
    log(`  Client: ${job.client}`);
    log(`  Service Type: ${job.serviceTypeId}`);
    log(`  Status: ${job.status}`);
    log(`  Description: ${job.description.length} chars`);
    return job;
  } catch (err) {
    log(`  ✗ Failed to read from contract: ${err.message}`);
    throw err;
  }
}

export async function fetchJobMessages(jobId) {
  // Job messages come from the leftclaw services API (off-chain)
  // These are separate from the on-chain job data
  log(`Fetching messages for job ${jobId}...`);
  try {
    const response = await fetch(`https://leftclaw.services/api/job/${jobId}/messages`);
    if (response.ok) {
      const data = await response.json();
      log(`  ✓ ${Array.isArray(data) ? data.length : 0} messages fetched`);
      return Array.isArray(data) ? data : [];
    }
  } catch (e) {
    // Fall through
  }
  log(`  ⚠ No messages available`);
  return [];
}

function parseCastTupleOutput(raw, jobId) {
  // cast outputs: (id, client, serviceTypeId, paymentClawd, priceUsd, "description", status,
  //   createdAt, startedAt, completedAt, "resultCID", worker, paymentClaimed, paymentMethod,
  //   cvAmount, "currentStage")
  //
  // Strategy: extract quoted strings first (they can contain commas/parens),
  // then parse the remaining numeric/address fields positionally.

  let s = raw.trim();
  // Strip outer parens
  if (s.startsWith('(') && s.endsWith(')')) {
    s = s.slice(1, -1);
  }

  // Extract all quoted strings in order, replacing them with placeholders
  const strings = [];
  let result = '';
  let inQuote = false;
  let current = '';
  let escaped = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      current += ch;
      continue;
    }
    if (ch === '"') {
      if (inQuote) {
        // End of string — unescape common sequences
        const unescaped = current.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"');
        strings.push(unescaped);
        result += `__STR${strings.length - 1}__`;
        current = '';
        inQuote = false;
      } else {
        inQuote = true;
        current = '';
      }
      continue;
    }
    if (inQuote) {
      current += ch;
    } else {
      result += ch;
    }
  }

  // Split remaining by comma, trim whitespace and cast annotations like [2e7]
  const parts = result.split(',').map(p => p.trim().replace(/\s*\[.*?\]\s*/g, ''));

  // Map positional fields
  // 0: id, 1: client, 2: serviceTypeId, 3: paymentClawd, 4: priceUsd,
  // 5: __STR0__ (description), 6: status, 7: createdAt, 8: startedAt,
  // 9: completedAt, 10: __STR1__ (resultCID), 11: worker,
  // 12: paymentClaimed, 13: paymentMethod, 14: cvAmount, 15: __STR2__ (currentStage)

  const getStr = (idx) => {
    const match = parts[idx]?.match(/__STR(\d+)__/);
    return match ? strings[parseInt(match[1])] : (parts[idx] || '');
  };
  const getNum = (idx) => parseInt(parts[idx] || '0', 10);
  const getAddr = (idx) => parts[idx] || '0x0';

  return {
    id: getNum(0) || jobId,
    client: getAddr(1),
    serviceTypeId: getNum(2),
    paymentClawd: getNum(3),
    priceUsd: getNum(4),
    description: getStr(5),
    status: getNum(6),
    createdAt: getNum(7),
    startedAt: getNum(8),
    completedAt: getNum(9),
    resultCID: getStr(10),
    worker: getAddr(11),
    currentStage: getStr(15),
  };
}
