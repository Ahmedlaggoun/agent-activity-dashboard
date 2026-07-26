// GitHub extraction via GraphQL (one query returns PRs + reviews + diff size +
// labels, far fewer calls than REST). Read-only: needs a PAT with `repo` (or
// `read:org` + repo read) scope. Works with github.com and GitHub Enterprise.
import { apiFetch, anonymize } from './util.mjs';

function graphqlUrl(apiBaseUrl) {
  // api.github.com -> https://api.github.com/graphql
  // GHE https://ghe.host/api/v3 -> https://ghe.host/api/graphql
  if (apiBaseUrl.includes('api.github.com')) return 'https://api.github.com/graphql';
  return apiBaseUrl.replace(/\/api\/v3\/?$/, '') + '/api/graphql';
}

async function gql(url, token, query, variables) {
  const data = await apiFetch(
    url,
    {
      method: 'POST',
      headers: { authorization: `bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    },
    { label: 'github-graphql' },
  );
  if (data.errors) throw new Error('GitHub GraphQL: ' + JSON.stringify(data.errors).slice(0, 400));
  return data.data;
}

const REPOS_QUERY = `query($org:String!,$cursor:String){
  organization(login:$org){ repositories(first:100, after:$cursor, orderBy:{field:PUSHED_AT,direction:DESC}){
    pageInfo{ hasNextPage endCursor } nodes{ name isArchived } } } }`;

export async function listOrgRepos(cfg, token) {
  const url = graphqlUrl(cfg.apiBaseUrl);
  const out = [];
  let cursor = null;
  do {
    const d = await gql(url, token, REPOS_QUERY, { org: cfg.org, cursor });
    const conn = d.organization?.repositories;
    if (!conn) break;
    for (const r of conn.nodes) if (!r.isArchived) out.push(r.name);
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);
  return out;
}

const PR_QUERY = `query($owner:String!,$name:String!,$cursor:String){
  repository(owner:$owner,name:$name){
    defaultBranchRef{ name }
    pullRequests(first:50, after:$cursor, orderBy:{field:CREATED_AT,direction:DESC}){
      pageInfo{ hasNextPage endCursor }
      nodes{
        number title state createdAt mergedAt closedAt
        additions deletions changedFiles
        baseRefName headRefName
        author{ login }
        labels(first:20){ nodes{ name } }
        reviews(first:1){ nodes{ submittedAt } }
      }
    }
  }
}`;

function isRevert(title, head) {
  return /^revert[\s:"]/i.test(title || '') || /(^|\/)revert[-/]/i.test(head || '');
}
function isHotfix(head, labels, failCfg) {
  const rx = failCfg.hotfixBranchPattern ? new RegExp(failCfg.hotfixBranchPattern) : null;
  const byBranch = rx ? rx.test(head || '') : false;
  const byLabel = (failCfg.hotfixLabels || []).some((l) => labels.includes(l));
  return byBranch || byLabel;
}
// Pull the first ticket key referenced by the branch or PR title.
function ticketKey(title, head, projectKeys) {
  const rx = new RegExp(`\\b(${(projectKeys || []).join('|') || '[A-Z][A-Z0-9]+'})-\\d+\\b`);
  return (head && head.match(rx)?.[0]) || (title && title.match(rx)?.[0]) || null;
}

/** Extract all PRs created on/after `sinceIso` for one repo. */
export async function extractRepoPRs(cfg, token, repo, sinceIso, failCfg, projectKeys, anon) {
  const url = graphqlUrl(cfg.apiBaseUrl);
  const sinceMs = new Date(sinceIso).getTime();
  const prs = [];
  let cursor = null;
  let defaultBranch = cfg.defaultBranchOverride || 'main';
  do {
    const d = await gql(url, token, PR_QUERY, { owner: cfg.org, name: repo, cursor });
    const r = d.repository;
    if (!r) break;
    if (r.defaultBranchRef?.name && !cfg.defaultBranchOverride) defaultBranch = r.defaultBranchRef.name;
    const conn = r.pullRequests;
    let reachedOld = false;
    for (const n of conn.nodes) {
      if (new Date(n.createdAt).getTime() < sinceMs) {
        reachedOld = true;
        continue; // ordered DESC; keep scanning page then stop
      }
      const labels = n.labels.nodes.map((l) => l.name);
      const head = n.headRefName;
      prs.push({
        repo,
        number: n.number,
        title: n.title,
        state: n.state,
        createdAt: n.createdAt,
        firstReviewAt: n.reviews.nodes[0]?.submittedAt ?? null,
        mergedAt: n.mergedAt,
        closedAt: n.closedAt,
        additions: n.additions,
        deletions: n.deletions,
        changedFiles: n.changedFiles,
        diffSize: n.additions + n.deletions,
        baseRef: n.baseRefName,
        headRef: head,
        mergedToDefault: !!n.mergedAt && n.baseRefName === defaultBranch,
        isRevert: isRevert(n.title, head),
        isHotfix: isHotfix(head, labels, failCfg),
        labels,
        ticket: ticketKey(n.title, head, projectKeys),
        author: anon(n.author?.login),
      });
    }
    cursor = conn.pageInfo.hasNextPage && !reachedOld ? conn.pageInfo.endCursor : null;
  } while (cursor);
  return { defaultBranch, prs };
}
