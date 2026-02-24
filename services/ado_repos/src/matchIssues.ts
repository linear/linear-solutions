import type { IssueMatchResult } from "./types.js";

// ---------------------------------------------------------------------------
// Magic word lists (ported from linear-app matchIssues.ts)
// ---------------------------------------------------------------------------

const CLOSING_WORDS = [
  "close",
  "closes",
  "closed",
  "closing",
  "fix",
  "fixes",
  "fixed",
  "fixing",
  "resolve",
  "resolves",
  "resolved",
  "resolving",
  "complete",
  "completes",
  "completed",
  "completing",
];

const CONTRIBUTING_PHRASES = [
  "ref",
  "refs",
  "references",
  "part of",
  "related to",
  "relates to",
  "contributes to",
  "towards",
  "toward",
];

const IGNORING_WORDS = ["skip", "ignore"];

const MAX_KEY_LENGTH = 7;

// ---------------------------------------------------------------------------
// Identifier regex (ported from linear-app IssueHelper.ts)
// ---------------------------------------------------------------------------

function identifierCoreRegex(teamKeys?: string[]): string {
  const keyPattern = teamKeys ? teamKeys.join("|") : `\\w{1,${MAX_KEY_LENGTH}}`;
  return `((${keyPattern})-([0-9]{1,9}))`;
}

/**
 * Build a regex string that matches issue identifiers (e.g. ENG-123) with proper
 * word boundaries, underscore awareness, and optional version-suffix exclusion.
 */
function identifierRegexString(opts?: {
  teamKeys?: string[];
  open?: boolean;
  excludeVersionSuffixes?: boolean;
}): string {
  const core = identifierCoreRegex(opts?.teamKeys);
  if (opts?.open) return core;

  const startBoundary = "(?:^|\\b|(?<=_))";
  const endBoundary = "(?:$|\\b|(?=_))";
  const versionExclusion = opts?.excludeVersionSuffixes ? "(?!\\.\\d)" : "";

  return `${startBoundary}${core}${endBoundary}${versionExclusion}`;
}

/**
 * Linear issue URL regex — matches https://linear.app/<team>/issue/TEAM-123
 */
function linearUrlRegexString(teamKeys?: string[]): string {
  const core = identifierCoreRegex(teamKeys);
  return `https://linear\\.app/[\\w-]+/issue/${core}(/[\\w-]+)?`;
}

// ---------------------------------------------------------------------------
// Identifier matching
// ---------------------------------------------------------------------------

interface ParsedIdentifier {
  rawIdentifier: string;
  identifier: string;
  teamKey: string;
  number: number;
}

function parseIdentifierMatch(match: RegExpMatchArray): ParsedIdentifier | undefined {
  const [, rawIdentifier, teamKey, numberString] = match;
  if (!rawIdentifier || !teamKey || !numberString) return undefined;

  // Leading-zero rejection: LIN-0004 won't match LIN-4
  if (Number(numberString).toString().length !== numberString.length) return undefined;

  const normalizedKey = teamKey.toUpperCase();
  return {
    rawIdentifier,
    identifier: `${normalizedKey}-${Number(numberString)}`,
    teamKey: normalizedKey,
    number: Number(numberString),
  };
}

/**
 * Extract all issue identifiers from a string.
 */
function matchIdentifiers(
  content: string,
  opts?: { teamKeys?: string[]; excludeVersionSuffixes?: boolean }
): string[] {
  if (!content.trim()) return [];

  const regexStr = identifierRegexString({
    teamKeys: opts?.teamKeys,
    excludeVersionSuffixes: opts?.excludeVersionSuffixes,
  });
  const regex = new RegExp(regexStr, "gi");

  const identifiers = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    const parsed = parseIdentifierMatch(match);
    if (parsed) {
      identifiers.add(parsed.identifier);
    }
  }

  return Array.from(identifiers);
}

// ---------------------------------------------------------------------------
// Magic word parsing (ported from linear-app matchIssues.ts)
// ---------------------------------------------------------------------------

/**
 * Build a regex that matches a magic word followed by one or more issue identifiers or Linear URLs.
 * Example: "closes ENG-123, ENG-456 and ENG-789"
 */
function magicWordRegex(words: string[], teamKeys?: string[]): RegExp {
  const identifierPart = identifierCoreRegex(teamKeys);
  const urlPart = linearUrlRegexString(teamKeys);
  const wordPart = words.join("|");

  return new RegExp(
    `\\b(${wordPart})[\\s:]+((?:${identifierPart}|${urlPart})(?:(?:[\\s,]|and|&)+(?:${identifierPart}|${urlPart}))*)\\b`,
    "gmi"
  );
}

interface MagicWordMatches {
  closes: Set<string>;
  contributes: Set<string>;
  ignores: Set<string>;
}

/**
 * Parse content for magic-word sentences and categorize matched identifiers.
 */
function identifyByMagicWord(
  content: string,
  teamKeys?: string[]
): MagicWordMatches {
  const matches: MagicWordMatches = {
    closes: new Set(),
    contributes: new Set(),
    ignores: new Set(),
  };

  const allWords = [...CLOSING_WORDS, ...CONTRIBUTING_PHRASES, ...IGNORING_WORDS];
  const regex = magicWordRegex(allWords, teamKeys);

  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    if (!line.trim()) continue;

    let match: RegExpExecArray | null;
    while ((match = regex.exec(line)) !== null) {
      const magicWord = match[1]!.toLowerCase();
      const issuesPart = match[2]!;
      const identifiers = matchIdentifiers(issuesPart, { teamKeys });

      if (IGNORING_WORDS.includes(magicWord)) {
        identifiers.forEach((id) => matches.ignores.add(id));
      } else if (CLOSING_WORDS.includes(magicWord)) {
        identifiers.forEach((id) => matches.closes.add(id));
      } else if (CONTRIBUTING_PHRASES.includes(magicWord)) {
        identifiers.forEach((id) => matches.contributes.add(id));
      }
    }
  }

  return matches;
}

// ---------------------------------------------------------------------------
// Body preprocessing (ported from linear-app matchIssues.ts)
// ---------------------------------------------------------------------------

function preprocessBody(body: string | null | undefined): string {
  if (!body) return "";
  return (
    body
      // Strip markdown links, keeping the URL (we support linking issues via URL)
      .replace(/\[(.*?)\]\((.*?)\)/g, "$1 $2")
      // Remove markdown/HTML comments
      .replace(/<!--.*?-->/gs, "")
  );
}

// ---------------------------------------------------------------------------
// Branch name extraction
// ---------------------------------------------------------------------------

function branchFromRef(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}

// ---------------------------------------------------------------------------
// Main matching function
// ---------------------------------------------------------------------------

/**
 * Match issue identifiers from a PR's title, description, and branch name.
 * Returns categorized identifiers: closes, contributes, ignores.
 *
 * Mirrors the logic in linear-app's matchIssuesWithMagicWords.
 */
export function matchIssuesForPullRequest(
  title: string,
  body: string | null | undefined,
  sourceRef: string,
  teamKeys?: string[]
): IssueMatchResult {
  const branch = branchFromRef(sourceRef);
  const transformedBody = preprocessBody(body);
  const magicWordText = `${title}\n${transformedBody}`;

  // Step 1: Parse magic words from title + body
  const magicMatches = identifyByMagicWord(magicWordText, teamKeys);

  const contributingIds = new Set(magicMatches.contributes);

  // Step 2: Extract identifiers from branch name and title (default to closes)
  // excludeVersionSuffixes prevents "release/ios-1.57.0" -> "IOS-1"
  const branchIdentifiers = matchIdentifiers(branch, { teamKeys, excludeVersionSuffixes: true });
  const titleIdentifiers = matchIdentifiers(title, { teamKeys, excludeVersionSuffixes: true });

  // Branch & title identifiers default to closes unless explicitly marked as contributing in body
  for (const ids of [branchIdentifiers, titleIdentifiers]) {
    for (const id of ids) {
      if (!contributingIds.has(id)) {
        magicMatches.closes.add(id);
      }
    }
  }

  const ignoreSet = magicMatches.ignores;

  // Step 3: Deduplicate and apply priority
  // Closing takes precedence over contributing
  const closes = [...magicMatches.closes].filter((id) => !ignoreSet.has(id));
  const closesSet = new Set(closes);
  const contributes = [...magicMatches.contributes].filter(
    (id) => !closesSet.has(id) && !ignoreSet.has(id)
  );
  const ignores = [...magicMatches.ignores];

  return { closes, contributes, ignores };
}

/**
 * Utility: extract a clean branch name from a source ref.
 */
export { branchFromRef };
