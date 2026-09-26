#!/usr/bin/env node

// Guard against documented install/update commands pointing at paths that do not
// exist in the repository (AUDIT.md C1). A fresh user copies these `curl` URLs
// verbatim, so a stale path is a hard 404 on the very first step.
//
// We verify that every `raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>`
// reference in Markdown resolves to a file that exists in the working tree and
// that it targets the default branch (`main`). The build artifacts a user pulls
// at install time appear under `releases`, which is not a repository path, so
// only `blob`/`raw` repository links are checked.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "stepan-pavlenko";
const REPO = "seclettr";
const DEFAULT_BRANCH = "main";

const RAW_URL_RE = new RegExp(
  `raw\\.githubusercontent\\.com/${OWNER}/${REPO}/([^/\\s)"'\`]+)/([^\\s)"'\`]+)`,
  "g"
);

const DOC_FILES = ["README.md", "DEPLOYMENT.md"];

const problems = [];

for (const doc of DOC_FILES) {
  const abs = path.join(ROOT, doc);
  if (!fs.existsSync(abs)) {
    problems.push(`${doc}: documented file is missing`);
    continue;
  }

  const content = fs.readFileSync(abs, "utf8");
  for (const match of content.matchAll(RAW_URL_RE)) {
    const ref = match[1];
    const repoPath = match[2];
    const location = `${doc}: ${match[0]}`;

    if (ref !== DEFAULT_BRANCH) {
      problems.push(
        `${location}: references branch "${ref}" instead of the default branch "${DEFAULT_BRANCH}"`
      );
    }

    const target = path.join(ROOT, repoPath);
    if (!fs.existsSync(target)) {
      problems.push(`${location}: path "${repoPath}" does not exist in the repository`);
    }
  }
}

if (problems.length > 0) {
  console.error("[check-doc-paths] Documented install paths are inconsistent:\n");
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}

console.log("[check-doc-paths] All documented raw URLs resolve to existing files.");
