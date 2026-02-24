import fs from "node:fs";
import path from "node:path";
import { log } from "./logger.js";
import type { AdoPrInfo, LinkKind } from "./types.js";

export interface StoredIssueLink {
  identifier: string;
  issueId: string;
  linkKind: LinkKind;
  title: string;
  url: string;
  teamId: string;
}

const STORE_PATH = path.resolve(process.cwd(), "data", "store.json");
const STORE_VERSION = 2;

interface StoreSnapshot {
  version?: number;
  prToIssues: [string, StoredIssueLink[]][];
  issueToPr: [string, AdoPrInfo][];
  syncRootByIssue: [string, string][];
  syncThreadByPr: [string, number][];
  adoToLinearComment: [string, string][];
  linearToAdoComment: [string, string][];
  ourLinearComments: string[];
  ourAdoComments: string[];
}

/**
 * Persistent store for PR<->issue links, sync thread roots, and comment mappings.
 * Backed by a JSON file so data survives server restarts.
 * For production use, replace with a proper database.
 */
class Store {
  private prToIssues = new Map<string, StoredIssueLink[]>();
  private issueToPr = new Map<string, AdoPrInfo>();
  private syncRootByIssue = new Map<string, string>();
  private syncThreadByPr = new Map<string, number>();
  private adoToLinearComment = new Map<string, string>();
  private linearToAdoComment = new Map<string, string>();
  /** Linear comment IDs created by this integration (for loop prevention) */
  private ourLinearComments = new Set<string>();
  /** ADO comment keys ("threadId:commentId") created by this integration */
  private ourAdoComments = new Set<string>();

  constructor() {
    this.load();
  }

  // -- Persistence --

  private load() {
    try {
      if (!fs.existsSync(STORE_PATH)) return;
      const raw = fs.readFileSync(STORE_PATH, "utf-8");
      const snap: StoreSnapshot = JSON.parse(raw);
      if ((snap.version ?? 0) !== STORE_VERSION) {
        log.info("store.version_mismatch", { expected: STORE_VERSION, found: snap.version });
        fs.unlinkSync(STORE_PATH);
        return;
      }
      this.prToIssues = new Map(snap.prToIssues);
      this.issueToPr = new Map(snap.issueToPr);
      this.syncRootByIssue = new Map(snap.syncRootByIssue);
      this.syncThreadByPr = new Map(snap.syncThreadByPr);
      this.adoToLinearComment = new Map(snap.adoToLinearComment);
      this.linearToAdoComment = new Map(snap.linearToAdoComment);
      this.ourLinearComments = new Set(snap.ourLinearComments ?? []);
      this.ourAdoComments = new Set(snap.ourAdoComments ?? []);
      log.info("store.loaded", {
        issues: this.prToIssues.size,
        syncRoots: this.syncRootByIssue.size,
        syncThreads: this.syncThreadByPr.size,
      });
    } catch (err) {
      log.error("store.load_failed", {}, err);
    }
  }

  private save() {
    try {
      const dir = path.dirname(STORE_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const snap: StoreSnapshot = {
        version: STORE_VERSION,
        prToIssues: [...this.prToIssues],
        issueToPr: [...this.issueToPr],
        syncRootByIssue: [...this.syncRootByIssue],
        syncThreadByPr: [...this.syncThreadByPr],
        adoToLinearComment: [...this.adoToLinearComment],
        linearToAdoComment: [...this.linearToAdoComment],
        ourLinearComments: [...this.ourLinearComments],
        ourAdoComments: [...this.ourAdoComments],
      };
      fs.writeFileSync(STORE_PATH, JSON.stringify(snap, null, 2));
    } catch (err) {
      log.error("store.save_failed", {}, err);
    }
  }

  // -- PR <-> Issue links --

  setIssueLinks(prKey: string, issues: StoredIssueLink[], prInfo: AdoPrInfo) {
    this.prToIssues.set(prKey, issues);
    for (const issue of issues) {
      this.issueToPr.set(issue.identifier, prInfo);
    }
    this.save();
  }

  getIssuesForPr(prKey: string): StoredIssueLink[] {
    return this.prToIssues.get(prKey) ?? [];
  }

  getPrForIssue(identifier: string): AdoPrInfo | undefined {
    return this.issueToPr.get(identifier);
  }

  // -- Synced thread roots (Linear side) --

  setSyncRoot(issueIdentifier: string, rootCommentId: string) {
    this.syncRootByIssue.set(issueIdentifier, rootCommentId);
    this.save();
  }

  getSyncRoot(issueIdentifier: string): string | undefined {
    return this.syncRootByIssue.get(issueIdentifier);
  }

  // -- Synced thread (ADO side) --

  setSyncThread(prKey: string, threadId: number) {
    this.syncThreadByPr.set(prKey, threadId);
    this.save();
  }

  getSyncThread(prKey: string): number | undefined {
    return this.syncThreadByPr.get(prKey);
  }

  // -- Comment mappings --

  setCommentMapping(adoThreadId: number, adoCommentId: number, linearCommentId: string) {
    const key = `ado:${adoThreadId}:${adoCommentId}`;
    this.adoToLinearComment.set(key, linearCommentId);
    this.linearToAdoComment.set(linearCommentId, key);
    this.save();
  }

  getLinearCommentId(adoThreadId: number, adoCommentId: number): string | undefined {
    return this.adoToLinearComment.get(`ado:${adoThreadId}:${adoCommentId}`);
  }

  getAdoCommentKey(linearCommentId: string): { threadId: number; commentId: number } | undefined {
    const key = this.linearToAdoComment.get(linearCommentId);
    if (!key) return undefined;
    const [, threadId, commentId] = key.split(":");
    return { threadId: parseInt(threadId!, 10), commentId: parseInt(commentId!, 10) };
  }

  // -- Integration-created comment tracking (loop prevention) --

  markLinearCommentAsOurs(commentId: string) {
    this.ourLinearComments.add(commentId);
    this.save();
  }

  isOurLinearComment(commentId: string): boolean {
    return this.ourLinearComments.has(commentId);
  }

  markAdoCommentAsOurs(threadId: number, commentId: number) {
    this.ourAdoComments.add(`${threadId}:${commentId}`);
    this.save();
  }

  isOurAdoComment(threadId: number, commentId: number): boolean {
    return this.ourAdoComments.has(`${threadId}:${commentId}`);
  }
}

export const store = new Store();
