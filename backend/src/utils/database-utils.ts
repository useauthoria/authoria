import { retry, RetryOptions } from './error-handling';

export enum DatabaseErrorType {
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  QUERY_ERROR = 'QUERY_ERROR',
  TRANSACTION_ERROR = 'TRANSACTION_ERROR',
  TIMEOUT = 'TIMEOUT',
  BATCH_SIZE_EXCEEDED = 'BATCH_SIZE_EXCEEDED',
  DEPENDENCY_ERROR = 'DEPENDENCY_ERROR',
  UNKNOWN = 'UNKNOWN',
}

export class DatabaseError extends Error {
  constructor(
    public readonly type: DatabaseErrorType,
    message: string,
    public readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'DatabaseError';
  }
}

interface SupabaseQuery {
  select: (fields: string, options?: { count?: string; head?: boolean }) => Promise<{ data: unknown[] | null; error: unknown; count?: number | null }> | SupabaseQuery;
  limit: (count: number) => SupabaseQuery;
  order: (field: string, opts: { ascending: boolean }) => SupabaseQuery;
  or: (condition: string) => SupabaseQuery;
  eq: (key: string, value: unknown) => SupabaseQuery;
  in: (key: string, values: readonly unknown[]) => SupabaseQuery;
  gt: (key: string, value: unknown) => SupabaseQuery;
  gte: (key: string, value: unknown) => SupabaseQuery;
  lt: (key: string, value: unknown) => SupabaseQuery;
  lte: (key: string, value: unknown) => SupabaseQuery;
  like: (key: string, pattern: string) => SupabaseQuery;
  ilike: (key: string, pattern: string) => SupabaseQuery;
  range: (from: number, to: number) => Promise<{ data: unknown[] | null; error: unknown }>;
  toString?: () => string;
}

interface SupabaseClient {
  from: (table: string) => SupabaseQuery;
}

export interface BatchOperation<T = unknown> {
  readonly id?: string;
  readonly type: 'insert' | 'update' | 'upsert' | 'delete';
  readonly table: string;
  readonly data?: T | readonly T[];
  readonly filter?: Readonly<Record<string, unknown>>;
  readonly select?: string;
  readonly priority?: number;
  readonly dependsOn?: readonly string[];
  readonly condition?: (context: BatchContext) => boolean;
  readonly retry?: RetryOptions;
}

export interface BatchContext {
  readonly results: ReadonlyMap<string, unknown>;
  readonly errors: ReadonlyMap<string, Error>;
  readonly completed: ReadonlySet<string>;
}

export interface BatchResult {
  readonly success: boolean;
  readonly results?: readonly unknown[];
  readonly mappedResults?: ReadonlyMap<string, unknown>;
  readonly errors?: readonly Array<{ readonly operation: number; readonly operationId?: string; readonly error: string; readonly type: string }>;
  readonly progress?: BatchProgress;
  readonly rollbackData?: readonly unknown[];
}

export interface BatchProgress {
  readonly total: number;
  readonly completed: number;
  readonly failed: number;
  readonly percentage: number;
  readonly estimatedTimeRemaining?: number;
}

export interface BatchConfig {
  readonly maxBatchSize?: number;
  readonly timeout?: number;
  readonly enableTransactions?: boolean;
  readonly enableRollback?: boolean;
  readonly retryOptions?: RetryOptions;
  readonly strategy?: 'sequential' | 'parallel' | 'smart';
  readonly priorityQueue?: boolean;
}

interface RollbackData {
  readonly operationId?: string;
  readonly type: string;
  readonly table: string;
  readonly data: readonly unknown[];
}

interface BatchOperationWithId extends BatchOperation<unknown> {
  readonly id: string;
  readonly priority: number;
}

export class DatabaseBatch {
  private static readonly DEFAULT_MAX_BATCH_SIZE = 1000;
  private static readonly DEFAULT_TIMEOUT = 60000;
  private static readonly DEFAULT_MAX_RETRIES = 3;
  private static readonly DEFAULT_RETRY_DELAY = 1000;
  private static readonly DEFAULT_PRIORITY = 5;
  private static readonly DEFAULT_DEPENDENCY_WAIT = 30000;
  private static readonly DEPENDENCY_CHECK_INTERVAL = 100;
  private static readonly ID_PREFIX = 'op_';
  private static readonly ID_RADIX = 36;
  private static readonly ID_SUBSTRING_START = 2;
  private static readonly ID_SUBSTRING_END = 11;
  private static readonly PERCENTAGE_MULTIPLIER = 100;

  private readonly supabase: SupabaseClient;
  private readonly operations: BatchOperationWithId[];
  private readonly config: Required<BatchConfig>;
  private readonly progressCallbacks: Array<(progress: BatchProgress) => void>;
  private startTime: number;

  constructor(supabase: SupabaseClient, config: BatchConfig = {}) {
    this.supabase = supabase;
    this.operations = [];
    this.config = {
      maxBatchSize: config.maxBatchSize ?? DatabaseBatch.DEFAULT_MAX_BATCH_SIZE,
      timeout: config.timeout ?? DatabaseBatch.DEFAULT_TIMEOUT,
      enableTransactions: config.enableTransactions ?? false,
      enableRollback: config.enableRollback ?? false,
      retryOptions: config.retryOptions ?? { maxAttempts: DatabaseBatch.DEFAULT_MAX_RETRIES, initialDelay: DatabaseBatch.DEFAULT_RETRY_DELAY },
      strategy: config.strategy ?? 'smart',
      priorityQueue: config.priorityQueue ?? true,
    };
    this.progressCallbacks = [];
    this.startTime = 0;
  }

  add(operation: BatchOperation<unknown>): void {
    this.validateOperation(operation);

    if (this.operations.length >= this.config.maxBatchSize) {
      throw new DatabaseError(
        DatabaseErrorType.BATCH_SIZE_EXCEEDED,
        `Batch size limit exceeded: ${this.config.maxBatchSize}`,
        { currentSize: this.operations.length },
      );
    }

    const opWithId: BatchOperationWithId = {
      ...operation,
      id: operation.id ?? `${DatabaseBatch.ID_PREFIX}${Date.now()}_${Math.random().toString(DatabaseBatch.ID_RADIX).substring(DatabaseBatch.ID_SUBSTRING_START, DatabaseBatch.ID_SUBSTRING_END)}`,
      priority: operation.priority ?? DatabaseBatch.DEFAULT_PRIORITY,
    };

    this.operations.push(opWithId);
  }

  private validateOperation(operation: BatchOperation<unknown>): void {
    if (!operation.type || !operation.table) {
      throw new DatabaseError(
        DatabaseErrorType.VALIDATION_ERROR,
        'Operation must have type and table',
        { operation },
      );
    }

    if ((operation.type === 'insert' || operation.type === 'upsert') && !operation.data) {
      throw new DatabaseError(
        DatabaseErrorType.VALIDATION_ERROR,
        'Insert/upsert operations must have data',
        { operation },
      );
    }

    if ((operation.type === 'update' || operation.type === 'delete') && !operation.filter && !operation.data) {
      throw new DatabaseError(
        DatabaseErrorType.VALIDATION_ERROR,
        'Update/delete operations must have filter or data',
        { operation },
      );
    }
  }

  async execute(): Promise<BatchResult> {
    this.startTime = Date.now();
    const results: unknown[] = [];
    const mappedResults = new Map<string, unknown>();
    const errors: Array<{ readonly operation: number; readonly operationId?: string; readonly error: string; readonly type: string }> = [];
    const rollbackData: RollbackData[] = [];
    const context: {
      results: Map<string, unknown>;
      errors: Map<string, Error>;
      completed: Set<string>;
    } = {
      results: new Map(),
      errors: new Map(),
      completed: new Set(),
    };

    const sortedOperations = this.config.priorityQueue
      ? [...this.operations].sort((a, b) => b.priority - a.priority)
      : this.operations;

    this.validateDependencies(sortedOperations);

    const grouped = this.groupOperations(sortedOperations);

    const executePromise = this.executeBatched(grouped, context, rollbackData);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new DatabaseError(DatabaseErrorType.TIMEOUT, 'Batch operation timeout')),
        this.config.timeout,
      ),
    );

    try {
      await Promise.race([executePromise, timeoutPromise]);
    } catch (error) {
      if (error instanceof DatabaseError && error.type === DatabaseErrorType.TIMEOUT) {
        if (this.config.enableRollback && rollbackData.length > 0) {
          await this.rollback(rollbackData);
        }
        throw error;
      }
      throw error;
    }

    sortedOperations.forEach((op, index) => {
      if (op.id && context.results.has(op.id)) {
        const result = context.results.get(op.id)!;
        results.push(result);
        mappedResults.set(op.id, result);
      } else if (op.id && context.errors.has(op.id)) {
        const error = context.errors.get(op.id)!;
        errors.push({
          operation: index,
          operationId: op.id,
          error: error.message,
          type: error.name || 'UnknownError',
        });
      }
    });

    const progress: BatchProgress = {
      total: sortedOperations.length,
      completed: context.completed.size,
      failed: errors.length,
      percentage: (context.completed.size / sortedOperations.length) * DatabaseBatch.PERCENTAGE_MULTIPLIER,
      estimatedTimeRemaining: this.calculateEstimatedTime(context.completed.size, sortedOperations.length),
    };

    this.progressCallbacks.forEach((callback) => {
      try {
        callback(progress);
      } catch {
      }
    });

    return {
      success: errors.length === 0,
      results: results.length > 0 ? results : undefined,
      mappedResults: mappedResults.size > 0 ? mappedResults : undefined,
      errors: errors.length > 0 ? errors : undefined,
      progress,
      rollbackData: this.config.enableRollback && rollbackData.length > 0 ? rollbackData : undefined,
    };
  }

  private async executeBatched(
    grouped: Readonly<Record<string, readonly BatchOperationWithId[]>>,
    context: { results: Map<string, unknown>; errors: Map<string, Error>; completed: Set<string> },
    rollbackData: RollbackData[],
  ): Promise<void> {
    if (this.config.enableTransactions) {
      await this.executeInTransaction(grouped, context, rollbackData);
    } else {
      switch (this.config.strategy) {
        case 'sequential':
          await this.executeSequential(grouped, context, rollbackData);
          break;
        case 'parallel':
          await this.executeParallel(grouped, context, rollbackData);
          break;
        case 'smart':
        default:
          await this.executeSmart(grouped, context, rollbackData);
          break;
      }
    }
  }

  private async executeSequential(
    grouped: Readonly<Record<string, readonly BatchOperationWithId[]>>,
    context: { results: Map<string, unknown>; errors: Map<string, Error>; completed: Set<string> },
    rollbackData: RollbackData[],
  ): Promise<void> {
    for (const [type, ops] of Object.entries(grouped)) {
      for (const op of ops) {
        await this.executeOperation(op, context, rollbackData);
      }
    }
  }

  private async executeParallel(
    grouped: Readonly<Record<string, readonly BatchOperationWithId[]>>,
    context: BatchContext,
    rollbackData: RollbackData[],
  ): Promise<void> {
    const allOps: BatchOperationWithId[] = [];
    for (const ops of Object.values(grouped)) {
      allOps.push(...ops);
    }

    await Promise.all(
      allOps.map(async (op) => {
        await this.waitForDependencies(op, context);
        return this.executeOperation(op, context, rollbackData);
      }),
    );
  }

  private async executeSmart(
    grouped: Readonly<Record<string, readonly BatchOperationWithId[]>>,
    context: BatchContext,
    rollbackData: RollbackData[],
  ): Promise<void> {
    for (const [type, ops] of Object.entries(grouped)) {
      if (type === 'insert' || type === 'upsert') {
        const byTable = this.groupByTable(ops);
        for (const tableOps of Object.values(byTable)) {
          for (const op of tableOps) {
            await this.waitForDependencies(op, context);
          }
          await this.executeGroup(type as BatchOperation<unknown>['type'], tableOps, context, rollbackData);
        }
      } else {
        await Promise.all(
          ops.map(async (op) => {
            await this.waitForDependencies(op, context);
            return this.executeOperation(op, context, rollbackData);
          }),
        );
      }
    }
  }

  private async executeInTransaction(
    grouped: Readonly<Record<string, readonly BatchOperationWithId[]>>,
    context: BatchContext,
    rollbackData: RollbackData[],
  ): Promise<void> {
    try {
      await this.executeSmart(grouped, context, rollbackData);
    } catch (error) {
      if (this.config.enableRollback) {
        await this.rollback(rollbackData);
      }
      throw error;
    }
  }

  private async waitForDependencies(op: BatchOperationWithId, context: BatchContext, maxWait: number = DatabaseBatch.DEFAULT_DEPENDENCY_WAIT): Promise<void> {
    if (!op.dependsOn || op.dependsOn.length === 0) {
      return;
    }

    const startTime = Date.now();
    while (Date.now() - startTime < maxWait) {
      const allCompleted = op.dependsOn.every((depId) => context.completed.has(depId));
      if (allCompleted) {
        return;
      }

      const anyFailed = op.dependsOn.some((depId) => context.errors.has(depId));
      if (anyFailed) {
        throw new DatabaseError(
          DatabaseErrorType.DEPENDENCY_ERROR,
          `Operation ${op.id} depends on failed operation`,
          { operationId: op.id, dependencies: op.dependsOn },
        );
      }

      await new Promise((resolve) => setTimeout(resolve, DatabaseBatch.DEPENDENCY_CHECK_INTERVAL));
    }

    throw new DatabaseError(
      DatabaseErrorType.TIMEOUT,
      `Timeout waiting for dependencies: ${op.dependsOn.join(', ')}`,
      { operationId: op.id },
    );
  }

  private async executeOperation(
    op: BatchOperationWithId,
    context: BatchContext,
    rollbackData: RollbackData[],
  ): Promise<void> {
    if (op.condition && !op.condition(context)) {
      context.completed.add(op.id);
      return;
    }

    if (this.config.enableRollback && (op.type === 'update' || op.type === 'delete')) {
      const rollback = await this.getRollbackData(op);
      if (rollback) {
        rollbackData.push(rollback);
      }
    }

    const executeFn = async () => {
      const result = await this.executeSingleOperation(op);
      context.results.set(op.id, result);
      context.completed.add(op.id);
      return result;
    };

    try {
      if (op.retry) {
        await retry(executeFn, op.retry);
      } else if (this.config.retryOptions) {
        await retry(executeFn, this.config.retryOptions);
      } else {
        await executeFn();
      }
    } catch (error) {
      context.errors.set(op.id, error instanceof Error ? error : new Error(String(error)));
      context.completed.add(op.id);
      throw error;
    }
  }

  private async getRollbackData(op: BatchOperationWithId): Promise<RollbackData | null> {
    if (op.type === 'update' || op.type === 'delete') {
      try {
        let query = this.supabase.from(op.table).select('*');
        if (op.filter) {
          Object.entries(op.filter).forEach(([key, value]) => {
            query = query.eq(key, value);
          });
        }
        const result = await query.select('*') as { data: unknown[] | null };
        return { operationId: op.id, type: op.type, table: op.table, data: result.data || [] };
      } catch {
        return null;
      }
    }
    return null;
  }

  private async rollback(rollbackData: ReadonlyArray<RollbackData>): Promise<void> {
    for (let i = rollbackData.length - 1; i >= 0; i--) {
      const rollback = rollbackData[i];
      try {
        if (rollback.type === 'update') {
          for (const record of rollback.data || []) {
            const recordWithId = record as { id: string; [key: string]: unknown };
            await this.supabase.from(rollback.table).update(record).eq('id', recordWithId.id);
          }
        } else if (rollback.type === 'delete') {
          if (rollback.data && rollback.data.length > 0) {
            await this.supabase.from(rollback.table).insert(rollback.data);
          }
        }
      } catch {
      }
    }
  }

  private async executeSingleOperation(op: BatchOperationWithId): Promise<unknown> {
    switch (op.type) {
      case 'insert':
        return this.executeInsert(op);
      case 'upsert':
        return this.executeUpsert(op);
      case 'update':
        return this.executeUpdate(op);
      case 'delete':
        return this.executeDelete(op);
      default:
        throw new DatabaseError(
          DatabaseErrorType.VALIDATION_ERROR,
          `Unknown operation type: ${op.type}`,
          { operation: op },
        );
    }
  }

  private async executeInsert(op: BatchOperationWithId): Promise<unknown> {
    const data = Array.isArray(op.data) ? op.data : [op.data];
    const result = await this.supabase.from(op.table).insert(data).select(op.select || '*') as { data: unknown[] | null; error: unknown };
    if (result.error) {
      throw new DatabaseError(
        DatabaseErrorType.QUERY_ERROR,
        `Insert failed: ${(result.error as Error).message}`,
        { error: result.error, operation: op },
      );
    }
    return result.data;
  }

  private async executeUpsert(op: BatchOperationWithId): Promise<unknown> {
    const data = Array.isArray(op.data) ? op.data : [op.data];
    const result = await this.supabase.from(op.table).upsert(data).select(op.select || '*') as { data: unknown[] | null; error: unknown };
    if (result.error) {
      throw new DatabaseError(
        DatabaseErrorType.QUERY_ERROR,
        `Upsert failed: ${(result.error as Error).message}`,
        { error: result.error, operation: op },
      );
    }
    return result.data;
  }

  private async executeUpdate(op: BatchOperationWithId): Promise<unknown> {
    let query = this.supabase.from(op.table).update(op.data);

    if (op.filter) {
      Object.entries(op.filter).forEach(([key, value]) => {
        query = query.eq(key, value);
      });
    }

    if (op.select) {
      query = query.select(op.select);
    } else {
      query = query.select();
    }

    const result = await query.select() as { data: unknown[] | null; error: unknown };
    if (result.error) {
      throw new DatabaseError(
        DatabaseErrorType.QUERY_ERROR,
        `Update failed: ${(result.error as Error).message}`,
        { error: result.error, operation: op },
      );
    }
    return result.data;
  }

  private async executeDelete(op: BatchOperationWithId): Promise<unknown> {
    let query = this.supabase.from(op.table).delete();

    if (op.filter) {
      Object.entries(op.filter).forEach(([key, value]) => {
        query = query.eq(key, value);
      });
    }

    const result = await query.select() as { data: unknown[] | null; error: unknown };
    if (result.error) {
      throw new DatabaseError(
        DatabaseErrorType.QUERY_ERROR,
        `Delete failed: ${(result.error as Error).message}`,
        { error: result.error, operation: op },
      );
    }
    return result.data;
  }

  private validateDependencies(operations: ReadonlyArray<BatchOperationWithId>): void {
    const operationIds = new Set(operations.map((op) => op.id).filter(Boolean));

    for (const op of operations) {
      if (op.dependsOn) {
        for (const depId of op.dependsOn) {
          if (!operationIds.has(depId)) {
            throw new DatabaseError(
              DatabaseErrorType.DEPENDENCY_ERROR,
              `Operation ${op.id} depends on non-existent operation: ${depId}`,
              { operationId: op.id, dependency: depId },
            );
          }
        }
      }
    }

    const visited = new Set<string>();
    const visiting = new Set<string>();

    const checkCycle = (opId: string): void => {
      if (visiting.has(opId)) {
        throw new DatabaseError(
          DatabaseErrorType.DEPENDENCY_ERROR,
          `Circular dependency detected: ${opId}`,
          { operationId: opId },
        );
      }
      if (visited.has(opId)) {
        return;
      }

      visiting.add(opId);
      const op = operations.find((o) => o.id === opId);
      if (op?.dependsOn) {
        for (const depId of op.dependsOn) {
          checkCycle(depId);
        }
      }
      visiting.delete(opId);
      visited.add(opId);
    };

    for (const op of operations) {
      if (op.id && !visited.has(op.id)) {
        checkCycle(op.id);
      }
    }
  }

  private groupOperations(operations: ReadonlyArray<BatchOperationWithId>): Readonly<Record<string, readonly BatchOperationWithId[]>> {
    const grouped: Record<string, BatchOperationWithId[]> = {};

    for (const op of operations) {
      if (!grouped[op.type]) {
        grouped[op.type] = [];
      }
      grouped[op.type].push(op);
    }

    return grouped;
  }

  private async executeGroup(
    type: BatchOperation<unknown>['type'],
    operations: ReadonlyArray<BatchOperationWithId>,
    context: BatchContext,
    rollbackData: RollbackData[],
  ): Promise<void> {
    if (type === 'insert' || type === 'upsert') {
      const allData: unknown[] = [];
      for (const op of operations) {
        if (Array.isArray(op.data)) {
          allData.push(...op.data);
        } else if (op.data) {
          allData.push(op.data);
        }
      }

      if (allData.length > 0) {
        const query = this.supabase.from(operations[0].table);
        const result = type === 'insert'
          ? await query.insert(allData).select()
          : await query.upsert(allData).select();

        const resultData = result as { data: unknown[] | null; error: unknown };
        if (resultData.error) {
          throw new DatabaseError(
            DatabaseErrorType.QUERY_ERROR,
            `Batch ${type} failed: ${(resultData.error as Error).message}`,
            { error: resultData.error },
          );
        }

        let resultIndex = 0;
        for (const op of operations) {
          const opDataCount = Array.isArray(op.data) ? op.data.length : 1;
          const opResults = (resultData.data || []).slice(resultIndex, resultIndex + opDataCount);
          context.results.set(op.id, opResults);
          context.completed.add(op.id);
          resultIndex += opDataCount;
        }
      }
    }
  }

  private groupByTable(operations: ReadonlyArray<BatchOperationWithId>): Readonly<Record<string, readonly BatchOperationWithId[]>> {
    const grouped: Record<string, BatchOperationWithId[]> = {};

    for (const op of operations) {
      if (!grouped[op.table]) {
        grouped[op.table] = [];
      }
      grouped[op.table].push(op);
    }

    return grouped;
  }

  private calculateEstimatedTime(completed: number, total: number): number | undefined {
    if (completed === 0) return undefined;

    const elapsed = Date.now() - this.startTime;
    const avgTimePerOp = elapsed / completed;
    const remaining = total - completed;
    return Math.round(avgTimePerOp * remaining);
  }

  onProgress(callback: (progress: BatchProgress) => void): () => void {
    this.progressCallbacks.push(callback);
    return () => {
      const index = this.progressCallbacks.indexOf(callback);
      if (index > -1) {
        this.progressCallbacks.splice(index, 1);
      }
    };
  }

  clear(): void {
    this.operations.length = 0;
    this.progressCallbacks.length = 0;
  }

  getCount(): number {
    return this.operations.length;
  }

  getStats(): Readonly<{
    readonly total: number;
    readonly byType: Readonly<Record<string, number>>;
    readonly byTable: Readonly<Record<string, number>>;
    readonly withDependencies: number;
    readonly withConditions: number;
  }> {
    const byType: Record<string, number> = {};
    const byTable: Record<string, number> = {};
    let withDependencies = 0;
    let withConditions = 0;

    for (const op of this.operations) {
      byType[op.type] = (byType[op.type] || 0) + 1;
      byTable[op.table] = (byTable[op.table] || 0) + 1;
      if (op.dependsOn && op.dependsOn.length > 0) {
        withDependencies++;
      }
      if (op.condition) {
        withConditions++;
      }
    }

    return {
      total: this.operations.length,
      byType,
      byTable,
      withDependencies,
      withConditions,
    };
  }
}

