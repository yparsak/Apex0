// Trunk-staleness scan for the Spec/Communication Protocol doc rework. Runs on its own
// slow interval inside worker.js (WORKER_SPEC_DOC_SCAN_INTERVAL_MS), separate from the
// fast per-session poll loop - enumerating every repo in the system and hitting GitHub
// once per repo is cheap at that cadence, but would not be at the session loop's 5s
// default.
//
// For every repo (app/lib/repos/repoAccess.js's listAllRepos - deliberately unscoped by
// user permission, since this is a system job covering the whole system, not one user's
// view of it): fetch the current HEAD sha of `default_branch_name`, and compare it
// against `repos.spec_doc_synced_commit_sha` (the trunk commit the *current* Spec CP doc
// reflects). A mismatch (including "never synced", i.e. NULL) means trunk has moved since
// the doc was last generated, so a job is enqueued - unless one is already in flight for
// this repo (specDocJobService.hasNonTerminalJobForRepo), which avoids piling up
// duplicate jobs across scan intervals while a regeneration is still running.
//
// A single repo's GitHub call failing (rate limit, transient network error, repo
// deleted/renamed) is logged and skipped rather than aborting the whole scan - the same
// per-item fault isolation githubRequest callers elsewhere in this project don't have to
// think about at the single-repo scale, but a system-wide scan does.

const logger = require('../logger');
const { listAllRepos } = require('../repos/repoAccess');
const { getLatestCommitSha } = require('../github/branchService');
const { hasNonTerminalJobForRepo, enqueueSpecDocJob } = require('./specDocJobService');

async function scanReposForStaleSpecDocs() {
  const repos = await listAllRepos();
  let enqueued = 0;

  for (const repo of repos) {
    try {
      const latestSha = await getLatestCommitSha({
        owner: repo.githubOwner,
        repoName: repo.name,
        branch: repo.defaultBranchName,
      });

      if (latestSha === repo.specDocSyncedCommitSha) continue;
      if (await hasNonTerminalJobForRepo(repo.id)) continue;

      await enqueueSpecDocJob({ repoId: repo.id, trunkCommitSha: latestSha });
      enqueued += 1;
    } catch (err) {
      logger.warn('spec doc staleness check failed for repo, skipping', { repoId: repo.id, repoName: repo.name, error: err.message });
    }
  }

  logger.info('spec doc staleness scan complete', { reposScanned: repos.length, jobsEnqueued: enqueued });
}

module.exports = { scanReposForStaleSpecDocs };
