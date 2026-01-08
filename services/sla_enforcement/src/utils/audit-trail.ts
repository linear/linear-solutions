/**
 * Audit trail persistence for compliance and debugging
 */

import * as fs from 'fs';
import * as path from 'path';
import { AuditEntry } from '../types';
import logger from './logger';

/**
 * Append an audit entry to the audit log file
 * Uses newline-delimited JSON format for easy parsing
 */
export async function logAudit(entry: AuditEntry, auditLogPath: string): Promise<void> {
  try {
    // Ensure directory exists
    const logDir = path.dirname(auditLogPath);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    // Append entry as newline-delimited JSON
    const logLine = JSON.stringify(entry) + '\n';
    
    await fs.promises.appendFile(auditLogPath, logLine, 'utf-8');
    
    logger.debug('Audit entry logged', {
      issueId: entry.issueId,
      action: entry.action,
      webhookId: entry.webhookId
    });
  } catch (error) {
    logger.error('Failed to write audit log', {
      error: (error as Error).message,
      entry: entry.issueId
    });
    // Don't throw - audit logging failure shouldn't stop enforcement
  }
}

/**
 * Read audit entries from the log file
 * Returns array of parsed entries
 */
export async function readAuditLog(auditLogPath: string, limit?: number): Promise<AuditEntry[]> {
  try {
    if (!fs.existsSync(auditLogPath)) {
      return [];
    }

    const content = await fs.promises.readFile(auditLogPath, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.length > 0);
    
    const entries = lines.map(line => {
      try {
        return JSON.parse(line) as AuditEntry;
      } catch (error) {
        logger.warn('Failed to parse audit log line', { error: (error as Error).message });
        return null;
      }
    }).filter((entry): entry is AuditEntry => entry !== null);

    // Return most recent entries if limit specified
    if (limit && limit > 0) {
      return entries.slice(-limit);
    }

    return entries;
  } catch (error) {
    logger.error('Failed to read audit log', {
      error: (error as Error).message,
      path: auditLogPath
    });
    return [];
  }
}

/**
 * Get audit statistics
 */
export async function getAuditStats(auditLogPath: string): Promise<{
  total: number;
  reverted: number;
  allowed: number;
  detected: number;
  lastEntry?: string;
}> {
  const entries = await readAuditLog(auditLogPath);
  
  return {
    total: entries.length,
    reverted: entries.filter(e => e.action === 'reverted').length,
    allowed: entries.filter(e => e.action === 'allowed').length,
    detected: entries.filter(e => e.action === 'detected').length,
    lastEntry: entries.length > 0 ? entries[entries.length - 1].timestamp : undefined
  };
}

