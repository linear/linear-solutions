import * as fs from 'fs';

interface CheckpointData {
  startedAt: string;
  cursor?: string;
  processedIds: string[];
  stats: {
    totalLinearIssues: number;
    matchedIssues: number;
    updatedIssues: number;
    skippedIssues: number;
    errorCount: number;
  };
}

export class CheckpointManager {
  private processedSet: Set<string>;

  private constructor(
    private filePath: string,
    private data: CheckpointData
  ) {
    this.processedSet = new Set(data.processedIds);
  }

  static tryLoad(filePath: string): CheckpointManager | null {
    if (!fs.existsSync(filePath)) return null;
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const data = JSON.parse(content) as CheckpointData;
      return new CheckpointManager(filePath, data);
    } catch {
      return null;
    }
  }

  static create(filePath: string): CheckpointManager {
    const data: CheckpointData = {
      startedAt: new Date().toISOString(),
      processedIds: [],
      stats: {
        totalLinearIssues: 0,
        matchedIssues: 0,
        updatedIssues: 0,
        skippedIssues: 0,
        errorCount: 0,
      },
    };
    return new CheckpointManager(filePath, data);
  }

  get startedAt(): string { return this.data.startedAt; }
  get cursor(): string | undefined { return this.data.cursor; }
  set cursor(value: string | undefined) { this.data.cursor = value; }
  get processedCount(): number { return this.processedSet.size; }
  get stats() { return this.data.stats; }

  isProcessed(issueId: string): boolean {
    return this.processedSet.has(issueId);
  }

  markProcessed(issueId: string): void {
    if (!this.processedSet.has(issueId)) {
      this.processedSet.add(issueId);
      this.data.processedIds.push(issueId);
    }
  }

  // Write atomically via a temp file to avoid corruption on crash
  save(): void {
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  delete(): void {
    if (fs.existsSync(this.filePath)) fs.unlinkSync(this.filePath);
  }
}
