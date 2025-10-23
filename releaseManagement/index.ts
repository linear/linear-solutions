import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();
const app = express();
app.use(bodyParser.json());

const PORT = 3000;

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const LINEAR_API_KEY = process.env.LINEAR_API_KEY || "";

// Call Linear GraphQL API
async function linearRequest(query: string, variables?: object) {
  try {
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": LINEAR_API_KEY
      },
      body: JSON.stringify({ query, variables })
    });

    if (!res.ok) {
      throw new Error(`Linear API HTTP error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json() as any;

    return data;
  } catch (error) {
    console.error("Linear API request failed:", error);
    throw error;
  }
}

// Get label by name from Linear
async function getLabelByName(name: string, groupId: string) {
  try {
    const query = `
      query ($name: String!, $groupId: ID!) {
        issueLabels(
          filter: { name: { eq: $name }, parent: { id: { eq: $groupId } } }
        ) {
          nodes {
            id
            name
            color
            parent {
              id
            }
          }
        }
      }
    `;
    const result = await linearRequest(query, { name, groupId }) as any;
    
    const labels = result.data?.issueLabels?.nodes || [];
    return labels.length > 0 ? labels[0] : null;
  } catch (error) {
    console.error(`Error getting Linear label by name "${name}":`, error);
    return null;
  }
}

// Create label in Linear or get existing one
async function createLinearLabelGroup() {
  try {
    // First, try to get existing label
    const query = `
      query($name: String!) {
        issueLabels(filter: { name: { eq: $name }, isGroup: { eq: true } }) {
          nodes {
            id
            name
            color
          }
        }
      }
    `;

    const result = await linearRequest(query, { name: "Releases" }) as any;
    
    // Safely access the first node
    const existingLabelGroup = result.data?.issueLabels?.nodes?.[0];
    
    if (existingLabelGroup) {
      console.log(`Using existing Linear label group: ${existingLabelGroup.name} (${existingLabelGroup.id})`);
      return existingLabelGroup;
    }

    // If not found, create new label group
    const mutation = `
      mutation($name: String!) {
        issueLabelCreate(input: { name: $name, isGroup: true }) {
          success
          issueLabel { id name }
        }
      }
    `;
    const createResult = await linearRequest(mutation, { name: "Releases" }) as any;
    
    if (!createResult.data?.issueLabelCreate?.success) {
      console.error(`Failed to create Linear label group for "Releases":`, createResult.errors?.[0]?.message || 'Unknown error');
      return null;
    }
  
    console.log(`Created new Linear label group: ${createResult.data.issueLabelCreate.issueLabel.name} (${createResult.data.issueLabelCreate.issueLabel.id})`);
    return createResult.data.issueLabelCreate.issueLabel;

  } catch (error) {
    console.error(`Error creating Linear label group "Releases":`, error);
    throw error;
  }
}

// Create label in Linear or get existing one
async function createLinearLabel(name: string) {
  try {
    // Create label group if it doesn't exist
    const labelGroup = await createLinearLabelGroup();
    if (!labelGroup) {
      console.error(`Failed to create Linear label group "Releases"`);
      return null;
    }

    // Try to get existing label
    const existingLabel = await getLabelByName(name, labelGroup.id);
    if (existingLabel) {
      console.log(`Using existing Linear label: ${existingLabel.name} (${existingLabel.id})`);
      return existingLabel;
    }

    // If not found, create new label
    const mutation = `
      mutation($name: String!, $groupId: String!) {
        issueLabelCreate(input: { name: $name, parentId: $groupId }) {
          success
          issueLabel { id name }
        }
      }
    `;
    const result = await linearRequest(mutation, { name: name, groupId: labelGroup.id }) as any;
    
    if (!result.data?.issueLabelCreate?.success) {
      console.error(`Failed to create Linear label for ${name}:`, result.errors?.[0]?.message || 'Unknown error');
      return null;
    }
  
    console.log(`Created new Linear label: ${result.data.issueLabelCreate.issueLabel.name} (${result.data.issueLabelCreate.issueLabel.id})`);
    return result.data.issueLabelCreate.issueLabel;

  } catch (error) {
    console.error(`Error creating Linear label "${name}":`, error);
    throw error;
  }
}

// Get current labels for an issue
async function getCurrentLabels(issueId: string): Promise<string[]> {
  try {
    const query = `
      query($issueId: String!) {
        issue(id: $issueId) {
          id
          labels {
            nodes {
              id
            }
          }
        }
      }
    `;
    const result = await linearRequest(query, { issueId }) as any;
    
    if (!result.data?.issue) {
      throw new Error(`Issue ${issueId} not found`);
    }
    
    return result.data.issue.labels.nodes.map((label: any) => label.id);
  } catch (error) {
    console.error(`Error getting current labels for issue ${issueId}:`, error);
    return [];
  }
}

// Add label to a Linear issue (preserving existing labels)
async function addLabelToIssue(issueId: string, labelId: string, labelName: string, issueKey: string) {
  try {
    // First, get current labels
    const currentLabelIds = await getCurrentLabels(issueId);
    
    // Add new label to existing ones (avoid duplicates)
    const updatedLabelIds = [...new Set([...currentLabelIds, labelId])];
    
    // If the label is already present, no need to update
    if (currentLabelIds.includes(labelId)) {
      console.log(`Label ${labelName} already exists on issue ${issueKey}`);
      return { data: { issueUpdate: { success: true } } };
    }
    
    const mutation = `
      mutation($issueId: String!, $labelIds: [String!]!) {
        issueUpdate(id: $issueId, input: { labelIds: $labelIds }) {
          success
          issue {
            id
            title
            labels {
              nodes {
                id
                name
              }
            }
          }
        }
      }
    `;
    const result = await linearRequest(mutation, { issueId, labelIds: updatedLabelIds }) as any;
    
    if (!result.data?.issueUpdate?.success) {
      throw new Error(`Failed to add label ${labelId} to issue ${issueId}`);
    }
    
    console.log(`Added label ${labelName} to issue ${issueKey} (now has ${updatedLabelIds.length} labels)`);
    return result;
  } catch (error) {
    console.error(`Error adding label ${labelName} to issue ${issueKey}:`, error);
    throw error;
  }
}

// Find issue by key (e.g., ENG-123)
async function findIssueIdByKey(key: string) {
  try {
    const query = `
      query($key: String!) {
        issue(id: $key) { id }
      }
    `;
    const res = await linearRequest(query, { key }) as any;
    return res.data?.issue?.id || null;
  } catch (error) {
    console.error(`Error finding Linear issue by key "${key}":`, error);
    return null; // Return null instead of throwing, so the process can continue with other issues
  }
}

// Batch find multiple issue IDs to reduce API calls
async function findIssueIdsByKeys(keys: string[]): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  
  if (keys.length === 0) {
    return results;
  }
  
  console.log(`Batch searching for ${keys.length} Linear issue IDs...`);
  
  // Process keys in parallel with a small delay to avoid rate limiting
  const batchSize = 10; // Process 10 at a time
  const batches = [];
  
  for (let i = 0; i < keys.length; i += batchSize) {
    batches.push(keys.slice(i, i + batchSize));
  }
  
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    if (batch) {
      const batchPromises = batch.map(async (key) => {
        try {
          const issueId = await findIssueIdByKey(key);
          if (issueId) {
            results.set(key, issueId);
          }
        } catch (error) {
          console.warn(`Failed to find issue ${key}:`, error);
        }
      });
      
      await Promise.all(batchPromises);
      
      // Add delay between batches to avoid rate limiting
      if (i < batches.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }
  
  console.log(`Found ${results.size}/${keys.length} Linear issue IDs`);
  return results;
}





interface GitHubRelease {
  id: number;
  tag_name: string;
  name: string;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string;
}

async function getPreviousRelease(
  repoFullName: string,
  tagName: string,
  token: string
): Promise<GitHubRelease | null> {
  const url = `https://api.github.com/repos/${repoFullName}/releases`;

  const res = await fetch(url, {
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${token}`
    }
  });

  if (!res.ok) {
    throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
  }

  const releases: GitHubRelease[] = await res.json() as GitHubRelease[];

  // Releases are in reverse chronological order (latest first)
  const index = releases.findIndex(r => r.tag_name === tagName);
  if (index !== -1 && index + 1 < releases.length) {
    return releases[index + 1] ?? null; // Previous release
  }

  return null; // No previous release found
}

// Get all team keys from Linear for exact matching
async function getLinearTeamKeys(): Promise<string[]> {
  try {
    const query = `
      query {
        viewer {
          organization {
            teams {
              nodes {
                key
                name
              }
            }
          }
        }
      }
    `;
    
    const result = await linearRequest(query) as any;
    const teams = result.data?.viewer?.organization?.teams?.nodes || [];
    
    const teamKeys = teams
      .filter((team: any) => team.key && team.key.length > 0)
      .map((team: any) => team.key);
    
    console.log(`Retrieved ${teamKeys.length} team keys from Linear: ${teamKeys.join(', ')}`);
    return teamKeys;
  } catch (error) {
    console.error('Error getting Linear team keys, using empty array:', error);
    return [];
  }
}

// Extract Linear issue keys from text using provided team keys
function extractLinearKeysWithTeamKeys(text: string, teamKeys: string[]): string[] {
  try {
    if (teamKeys.length > 0) {
      console.log(`Using exact team key matching with ${teamKeys.length} team keys.`);
      
      const foundKeys = new Map<string, string>(); // Use Map to preserve original case while ensuring uniqueness
      
      // Create exact patterns for each team key (case-insensitive)
      for (const teamKey of teamKeys) {
        // Escape regex metacharacters in team key
        const escapedTeamKey = teamKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(`\\b${escapedTeamKey}-\\d+\\b`, 'gi');
        const matches = text.match(pattern);
        
        if (matches) {
          matches.forEach(match => {
            // Normalize to uppercase for case-insensitive uniqueness check
            const normalizedKey = match.toUpperCase();
            // Store the first occurrence of this key (preserving original case)
            if (!foundKeys.has(normalizedKey)) {
              foundKeys.set(normalizedKey, match);
            }
          });
        }
      }
      
      if (foundKeys.size > 0) {
        console.log(`Found ${foundKeys.size} issue keys using exact team key matching.`);
        return Array.from(foundKeys.values());
      } else {
        console.log('No exact matches found, falling back to regex pattern');
      }
    }
    
    // Fallback to dynamic regex pattern if exact matching yields no results
    // Use the team keys we already have to determine max key length
    const maxKeyLength = teamKeys.length > 0 ? Math.max(...teamKeys.map(key => key.length)) : 10;
    
    // Create regex pattern based on dynamic max key length (case-insensitive)
    const pattern = new RegExp(`\\b[A-Za-z]{2,${maxKeyLength}}-\\d+\\b`, 'gi');
    const matches = text.match(pattern);
    
    if (matches) {
      console.log(`Found ${matches.length} issue keys using regex fallback: ${matches.join(', ')}`);
      // Use Map for case-insensitive uniqueness in fallback as well
      const uniqueKeys = new Map<string, string>();
      matches.forEach(match => {
        const normalizedKey = match.toUpperCase();
        if (!uniqueKeys.has(normalizedKey)) {
          uniqueKeys.set(normalizedKey, match);
        }
      });
      return Array.from(uniqueKeys.values());
    }
    
    return [];
  } catch (error) {
    console.error('Error extracting Linear keys, using fallback pattern:', error);
    // Fallback to basic pattern if everything fails (case-insensitive)
    const fallbackMatches = text.match(/\\b[A-Za-z]{2,10}-\\d+\\b/gi);
    if (fallbackMatches) {
      const uniqueKeys = new Map<string, string>();
      fallbackMatches.forEach(match => {
        const normalizedKey = match.toUpperCase();
        if (!uniqueKeys.has(normalizedKey)) {
          uniqueKeys.set(normalizedKey, match);
        }
      });
      return Array.from(uniqueKeys.values());
    }
    return [];
  }
}

// Extract Linear issue keys from text (legacy function for backward compatibility)
async function extractLinearKeys(text: string): Promise<string[]> {
  const teamKeys = await getLinearTeamKeys();
  return extractLinearKeysWithTeamKeys(text, teamKeys);
}

// Get commits between two releases/tags
async function getCommitsBetweenReleases(
  repoFullName: string,
  token: string,
  fromTag: string,
  toTag: string
): Promise<any[]> {
  try {
    // This is a hardcoded version of the compare URL for demo purposes, the commented line is the correct code for the real thing
    const compareUrl = `https://api.github.com/repos/${repoFullName}/compare/${fromTag}...${toTag}`;
    // const compareUrl = `https://api.github.com/repos/${repoFullName}/compare/v1...${toTag}`;
    
    const res = await fetch(compareUrl, {
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${token}`
      }
    });

    if (!res.ok) {
      throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
    }

    const compareData = await res.json() as any;
    
    if (!compareData.commits) {
      console.warn(`No commits found between ${fromTag} and ${toTag}`);
      return [];
    }
    
    return compareData.commits;
  } catch (error) {
    console.error(`Error getting commits between ${fromTag} and ${toTag}:`, error);
    throw error;
  }
}

// Get PRs associated with commits in a release
async function getPRsFromCommits(
  repoFullName: string,
  token: string,
  commits: any[]
): Promise<any[]> {
  try {
    if (!commits || commits.length === 0) {
      console.log('No commits provided to extract PRs from');
      return [];
    }

    const prNumbers = new Set<number>();
    
    // Extract PR numbers from commit messages (e.g., "Merge pull request #123")
    for (const commit of commits) {
      try {
        const message = commit?.commit?.message || '';
        const prMatch = message.match(/Merge pull request #(\d+)|#(\d+)/g);
        if (prMatch) {
          prMatch.forEach((match: string) => {
            const num = match.match(/\d+/);
            if (num) prNumbers.add(parseInt(num[0]));
          });
        }
      } catch (error) {
        console.warn('Error processing commit message:', error);
      }
    }

    if (prNumbers.size === 0) {
      console.log('No PR numbers found in commit messages');
      return [];
    }

    console.log(`Found ${prNumbers.size} PR numbers: ${Array.from(prNumbers).join(', ')}`);

    // Fetch PR details
    const prs: any[] = [];
    for (const prNumber of prNumbers) {
      try {
        const prRes = await fetch(`https://api.github.com/repos/${repoFullName}/pulls/${prNumber}`, {
          headers: {
            "Accept": "application/vnd.github+json",
            "Authorization": `Bearer ${token}`
          }
        });
        
        if (prRes.ok) {
          const prData = await prRes.json();
          prs.push(prData);
        } else {
          console.warn(`Failed to fetch PR #${prNumber}: ${prRes.status} ${prRes.statusText}`);
        }
      } catch (error) {
        console.warn(`Failed to fetch PR #${prNumber}:`, error);
      }
    }

    console.log(`Successfully fetched ${prs.length}/${prNumbers.size} PRs`);
    return prs;
  } catch (error) {
    console.error('Error in getPRsFromCommits:', error);
    return []; // Return empty array to allow processing to continue
  }
}

// Scan commits in a release changelog for Linear keys
async function scanReleaseCommitsForLinearKeys(
  commits: any[],
  teamKeys: string[]
): Promise<{ commit: any, linearKeys: string[] }[]> {
  const results: { commit: any, linearKeys: string[] }[] = [];

  for (const commit of commits) {
    const message = commit.commit.message;
    const linearKeys = extractLinearKeysWithTeamKeys(message, teamKeys);
    
    if (linearKeys.length > 0) {
      results.push({
        commit: {
          sha: commit.sha,
          message: commit.commit.message,
          author: commit.commit.author,
          url: commit.html_url,
          date: commit.commit.author.date
        },
        linearKeys
      });
    }
  }

  return results;
}

// Scan pull requests in a release changelog for Linear keys
async function scanReleasePRsForLinearKeys(
  commits: any[],
  repoFullName: string,
  token: string,
  teamKeys: string[]
): Promise<{ pr: any, linearKeys: string[] }[]> {
  // Get PRs associated with the provided commits
  const prs = await getPRsFromCommits(repoFullName, token, commits);
  
  const results: { pr: any, linearKeys: string[] }[] = [];

  for (const pr of prs) {
    const titleKeys = extractLinearKeysWithTeamKeys(pr.title, teamKeys);
    const bodyKeys = pr.body ? extractLinearKeysWithTeamKeys(pr.body, teamKeys) : [];
    const allKeys = [...new Set([...titleKeys, ...bodyKeys])];
    
    if (allKeys.length > 0) {
      results.push({
        pr: {
          number: pr.number,
          title: pr.title,
          body: pr.body,
          state: pr.state,
          url: pr.html_url,
          created_at: pr.created_at,
          updated_at: pr.updated_at,
          user: pr.user.login,
          merged_at: pr.merged_at
        },
        linearKeys: allKeys
      });
    }
  }

  return results;
}

// Search for Linear issues by VCS branch names
async function searchIssuesByBranchNames(branchNames: string[]): Promise<string[]> {
  try {
    if (!branchNames || branchNames.length === 0) {
      console.log('No branch names provided for search');
      return [];
    }

    const foundIssueKeys = new Set<string>();
    const processedBranches = new Set<string>();
    
    for (const branchName of branchNames) {
      try {
        // Skip if we've already processed this branch name
        if (processedBranches.has(branchName)) {
          continue;
        }
        processedBranches.add(branchName);
        
        // Clean the branch name for search
        const cleanBranchName = branchName.replace(/[^a-zA-Z0-9\-_\/]/g, ' ').trim();
        if (cleanBranchName.length < 3) {
          console.log(`Skipping branch name "${branchName}" - too short after cleaning`);
          continue;
        }
        
        console.log(`Searching for issues with branch name: "${cleanBranchName}"`);
        
        // Use Linear's issueVcsBranchSearch to find issues with this branch name
        const query = `
          query($branchName: String!) {
            issueVcsBranchSearch(branchName: $branchName) {
                id
                identifier
                title
                branchName
            }
          }
        `;
        
        const result = await linearRequest(query, { branchName: cleanBranchName }) as any;
        const foundIssue = result.data?.issueVcsBranchSearch;
        
        if (foundIssue) {
          console.log(`Found ${foundIssue.identifier} issue for branch "${cleanBranchName}":`);
          foundIssueKeys.add(foundIssue.identifier);
        } else {
          console.log(`No issues found for branch "${cleanBranchName}"`);
        }
        
        // Add a small delay between searches to avoid rate limiting
        if (branchNames.length > 1) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } catch (error) {
        console.warn(`Error searching for branch "${branchName}":`, error);
        // Continue with other branch names even if one fails
      }
    }

    const uniqueKeys = Array.from(foundIssueKeys);
    console.log(`Total unique issues found by branch search: ${uniqueKeys.length}`);
    return uniqueKeys;
  } catch (error) {
    console.error('Error in searchIssuesByBranchNames:', error);
    return [];
  }
}

// Extract branch names from commits using GitHub API
// This function queries GitHub's API to get actual branch information for each commit,
// which is more accurate than regex pattern matching on commit messages.
// It uses three methods in order of preference:
// 1. Direct ref information from commit data
// 2. Query which branches contain the commit
// 3. Fallback to regex patterns in commit message
async function extractBranchNamesFromCommits(commits: any[], repoFullName: string, token: string): Promise<string[]> {
  const branchNames = new Set<string>();
  
  // Limit the number of commits processed to avoid excessive API calls
  const maxCommitsToProcess = 50; // Process max 50 commits for branch info
  const commitsToProcess = commits.slice(0, maxCommitsToProcess);
  
  console.log(`Querying GitHub API for branch information for ${commitsToProcess.length} commits (limited from ${commits.length} total)...`);
  
  for (const commit of commitsToProcess) {
    try {
      const sha = commit?.sha;
      if (!sha) {
        console.warn('Commit missing SHA, skipping');
        continue;
      }
      
      // Query GitHub API to get branch information for this commit
      // Method 1: Try to get commit details first
      const commitUrl = `https://api.github.com/repos/${repoFullName}/commits/${sha}`;
      const commitRes = await fetch(commitUrl, {
        headers: {
          "Accept": "application/vnd.github+json",
          "Authorization": `Bearer ${token}`
        }
      });
      
      if (!commitRes.ok) {
        console.warn(`Failed to fetch commit info for ${sha}: ${commitRes.status} ${commitRes.statusText}`);
        continue;
      }
      
      const commitData = await commitRes.json() as any;
      
      // Try to get branch information from the commit
      let branchName = '';
      
      // Check if the commit has a ref (branch) associated
      if (commitData.ref) {
        branchName = commitData.ref.replace(/^refs\/heads\//, '');
        console.log(`  Commit ${sha.substring(0, 7)} has ref: ${branchName}`);
      }
      
      // Method 2: If no ref, try to find which branches contain this commit
      if (!branchName) {
        try {
          const branchesUrl = `https://api.github.com/repos/${repoFullName}/commits/${sha}/branches-where-head`;
          const branchesRes = await fetch(branchesUrl, {
            headers: {
              "Accept": "application/vnd.github+json",
              "Authorization": `Bearer ${token}`
            }
          });
          
          if (branchesRes.ok) {
            const branchesData = await branchesRes.json() as any[];
            if (branchesData && branchesData.length > 0) {
              // Use the first branch found
              branchName = branchesData[0].name;
              console.log(`  Commit ${sha.substring(0, 7)} found in branch: ${branchName}`);
            }
          }
        } catch (branchError) {
          console.warn(`Failed to get branches for commit ${sha}:`, branchError);
        }
      }
      
      // Method 3: Fallback to regex patterns in commit message if still no branch found
      if (!branchName) {
        const message = commit?.commit?.message || '';
        
        // Look for common branch patterns in commit message
        const branchPatterns = [
          /feature\/([a-zA-Z0-9\-_]+)/gi,
          /bugfix\/([a-zA-Z0-9\-_]+)/gi,
          /hotfix\/([a-zA-Z0-9\-_]+)/gi,
          /release\/([a-zA-Z0-9\-_]+)/gi,
          /(?:branch|br):\s*([a-zA-Z0-9\-_\/]+)/gi,
          /(?:wip|work-in-progress):\s*([a-zA-Z0-9\-_\/]+)/gi
        ];
        
        for (const pattern of branchPatterns) {
          const matches = message.match(pattern);
          if (matches && matches.length > 0) {
            const match = matches[0];
            const branchMatch = match.match(/([a-zA-Z0-9\-_\/]+)$/);
            if (branchMatch && branchMatch[1]) {
              branchName = branchMatch[1].trim();
              console.log(`  Extracted branch name from commit message: "${branchName}" for commit ${sha.substring(0, 7)}`);
              break;
            }
          }
        }
      }
      
      if (branchName && branchName.length > 2) {
        // Filter out common branch names that aren't useful for search
        const commonBranches = ['main', 'master', 'dev', 'develop', 'staging', 'prod', 'production', 'test', 'tmp', 'temp'];
        if (!commonBranches.includes(branchName.toLowerCase())) {
          branchNames.add(branchName);
          console.log(`  Found branch: "${branchName}" for commit ${sha.substring(0, 7)}`);
        }
      }
      
       // Add a small delay to avoid rate limiting (GitHub allows 5000 requests per hour for authenticated users)
       if (commitsToProcess.length > 1) {
         await new Promise(resolve => setTimeout(resolve, 100));
       }
      
    } catch (error) {
      console.warn(`Error processing commit ${commit?.sha} for branch info:`, error);
    }
  }
  
  const uniqueBranches = Array.from(branchNames);
  console.log(`Extracted ${uniqueBranches.length} unique branch names from GitHub API`);
  return uniqueBranches;
}

app.post("/github-webhook", async (req, res) => {
  const event = req.headers["x-github-event"];
  if (event !== "release") {
    return res.status(200).send("Ignoring non-release event");
  }

  const payload = req.body;
  const action = payload.action;
  const tagName = payload.release?.tag_name;
  const repoFullName = payload.repository?.full_name;
  
  // Only process major release states, ignore edits and deletions
  if (action == "edited" || action == "deleted") {
    console.log(`Ignoring release ${tagName} for ${repoFullName} - action: ${action} (only processing created, prereleased, published, released, and unpublished events)`);
    return res.status(200).json({ 
      message: `Ignoring ${action} event for release ${tagName}`,
      action,
      tagName,
      repoFullName,
      timestamp: new Date().toISOString()
    });
  }
  
  console.log(`Processing ${action} release ${tagName} for ${repoFullName}`);
  
  // 1. IMMEDIATELY send response to GitHub to prevent timeout
  res.status(200).json({ 
    message: `Webhook received, processing ${action} release asynchronously`,
    action,
    tagName,
    repoFullName,
    timestamp: new Date().toISOString()
  });
  
  // 2. Process the release asynchronously in the background
  processReleaseAsync(payload, tagName, repoFullName).catch(error => {
    console.error('Background processing error:', error);
  });

  return;
});

// Separate async function for background processing
async function processReleaseAsync(payload: any, tagName: string, repoFullName: string): Promise<void> {
  // Track API calls for performance monitoring
  let apiCallCount = 0;
  
  try {
    const previousRelease = await getPreviousRelease(repoFullName, tagName, GITHUB_TOKEN);
    apiCallCount++; // GitHub API call for releases
    
    if (!previousRelease) {
      console.log(`No previous release found for ${tagName}, skipping processing`);
      return Promise.resolve();
    }

    // 1. Create label in Linear
    let label = await createLinearLabel(tagName);
    apiCallCount += 2; // Linear API calls for label group and label creation
    if (!label) {
      console.error(`Failed to create or find Linear label for ${tagName}`);
      return Promise.resolve();
    }
    
           // 2. Get team keys once to avoid multiple API calls
      let teamKeys: string[] = [];
      try {
        teamKeys = await getLinearTeamKeys();
        apiCallCount++; // Linear API call for team keys
        console.log(`Retrieved ${teamKeys.length} team keys from Linear for issue detection`);
      } catch (error) {
        console.error('Failed to get Linear team keys, using empty array:', error);
        teamKeys = [];
      }
     
      // 3. Get all commits between releases ONCE (eliminates duplicate API calls)
      let allCommits: any[] = [];
      try {
        allCommits = await getCommitsBetweenReleases(repoFullName, GITHUB_TOKEN, previousRelease.tag_name, tagName);
        apiCallCount++; // GitHub API call for commits comparison
        console.log(`Retrieved ${allCommits.length} total commits for analysis`);
      } catch (error) {
        console.error(`Failed to get commits:`, error);
        allCommits = [];
        return Promise.resolve();
      }

      // 4. Scan commits and PRs using the commits we already have
      let commitResults: { commit: any, linearKeys: string[] }[] = [];
      let prResults: { pr: any, linearKeys: string[] }[] = [];
      
      try {
        [commitResults, prResults] = await Promise.all([
          scanReleaseCommitsForLinearKeys(allCommits, teamKeys),
          scanReleasePRsForLinearKeys(allCommits, repoFullName, GITHUB_TOKEN, teamKeys)
        ]);
        
        // Count API calls for PR fetching (varies based on number of PRs found)
        const prCount = prResults.length;
        apiCallCount += prCount; // GitHub API calls for each PR
        
        console.log(`Found ${commitResults.length} commits and ${prResults.length} PRs with Linear keys`);
      } catch (error) {
        console.error(`Failed to scan release changelog:`, error);
        return Promise.resolve();
      }

           // 5. Extract branch names and search for related issues
      let branchBasedIssueKeys: string[] = [];
      try {
        const branchNames = await extractBranchNamesFromCommits(allCommits, repoFullName, GITHUB_TOKEN);
        // Count API calls for branch extraction (limited to max 50 commits)
        const commitsProcessed = Math.min(allCommits.length, 50);
        apiCallCount += commitsProcessed * 2; // GitHub API calls for commit details + branches
        
        console.log(`Extracted ${branchNames.length} branch names: ${branchNames.join(', ')}`);
        
        if (branchNames.length > 0) {
          console.log(`Starting branch-based issue search...`);
          branchBasedIssueKeys = await searchIssuesByBranchNames(branchNames);
          apiCallCount += branchNames.length; // Linear API calls for branch search
          console.log(`Branch search completed. Found ${branchBasedIssueKeys.length} issues by branch search`);
        } else {
          console.log(`No branch names extracted, skipping branch search`);
        }
      } catch (error) {
        console.error(`Failed to search issues by branch names:`, error);
        branchBasedIssueKeys = [];
      }

     // 6. Collect all Linear issue keys from commits, PRs, and branch searches
     const issueKeys = new Map<string, string>(); // Use Map for case-insensitive uniqueness
     try {
       commitResults.forEach(result => result.linearKeys.forEach(key => {
         const normalizedKey = key.toUpperCase();
         if (!issueKeys.has(normalizedKey)) {
           issueKeys.set(normalizedKey, key);
         }
       }));
       prResults.forEach(result => result.linearKeys.forEach(key => {
         const normalizedKey = key.toUpperCase();
         if (!issueKeys.has(normalizedKey)) {
           issueKeys.set(normalizedKey, key);
         }
       }));
       branchBasedIssueKeys.forEach(key => {
         const normalizedKey = key.toUpperCase();
         if (!issueKeys.has(normalizedKey)) {
           issueKeys.set(normalizedKey, key);
         }
       });
     } catch (error) {
       console.error('Error collecting Linear keys:', error);
       return Promise.resolve();
     }

     console.log("Found Linear issue keys:");
     console.log(`  - From commit messages: ${commitResults.reduce((acc, result) => acc + result.linearKeys.length, 0)}`);
     console.log(`  - From PR titles/bodies: ${prResults.reduce((acc, result) => acc + result.linearKeys.length, 0)}`);
     console.log(`  - From branch name search: ${branchBasedIssueKeys.length}`);
     console.log(`  - Total unique issues: ${issueKeys.size}`);
     console.log("All issue keys:", Array.from(issueKeys.values()));

           // 7. Batch find all Linear issue IDs to reduce API calls
      const issueIdMap = await findIssueIdsByKeys(Array.from(issueKeys.values()));
      apiCallCount += issueKeys.size; // Linear API calls for issue ID lookup
      
      // 8. Apply label to each found issue
      const labelingResults: { key: string, success: boolean, reason?: string }[] = [];
      for (const key of issueKeys.values()) {
        try {
          const issueId = issueIdMap.get(key);
          if (issueId) {
            await addLabelToIssue(issueId, label.id, tagName, key);
            apiCallCount += 2; // Linear API calls: get current labels + update labels
            labelingResults.push({ key, success: true });
          } else {
            console.warn(`No Linear issue found for key: ${key}`);
            labelingResults.push({ key, success: false, reason: 'Issue not found' });
          }
        } catch (error) {
          console.error(`Failed to label issue ${key}:`, error);
          labelingResults.push({ key, success: false, reason: error instanceof Error ? error.message : String(error) });
        }
      }

    const successCount = labelingResults.filter(r => r.success).length;
    const totalCount = labelingResults.length;
    console.log(`Successfully labeled ${successCount}/${totalCount} issues`);

    if (successCount === 0 && totalCount > 0) {
      console.warn('No issues were successfully labeled');
    }


           console.log(`Successfully completed background processing for release ${tagName}`);
      console.log(`📊 Performance Summary:`);
      console.log(`  - Commits processed: ${allCommits.length}`);
      console.log(`  - Linear issues found: ${issueKeys.size}`);
      console.log(`  - Issues labeled: ${labelingResults.filter(r => r.success).length}`);
      console.log(`  - Total API calls made: ${apiCallCount}`);
      console.log(`  - API calls breakdown:`);
      console.log(`    • GitHub: ${1 + 1 + prResults.length + Math.min(allCommits.length, 50) * 2} (releases + commits + PRs + branch info)`);
      console.log(`    • Linear: ${2 + 1 + issueKeys.size + labelingResults.filter(r => r.success).length * 2} (labels + team keys + issue lookup + labeling)`);
    } catch (err) {
      console.error("Error in background processing:", err);
    }
  
  // Explicit return to satisfy TypeScript
  return Promise.resolve();
}

// Add health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({ 
    status: "healthy", 
    timestamp: new Date().toISOString(),
    version: "1.0.0",
    services: {
      linear: "configured",
      github: "configured"
    }
  });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`POST /github-webhook - Process GitHub release webhooks`);
  console.log(`GET /health - Health check endpoint`);
});
