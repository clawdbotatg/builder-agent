import fs from 'fs';
import path from 'path';

export function createBuildFolder(jobId) {
  const now = new Date();
  const timestamp = now.toISOString()
    .replace(/[-:T]/g, '')
    .replace(/\..+/, '')
    .replace(/^(\d{8})(\d{6})$/, '$1-$2');
  const folderName = `job-${jobId}-${timestamp}`;
  const folderPath = path.join(process.cwd(), 'builds', folderName);
  fs.mkdirSync(path.join(folderPath, 'skills'), { recursive: true });
  return folderPath;
}

export function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

export function readFile(filePath) {
  return fs.readFileSync(filePath, 'utf-8');
}

export function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}
