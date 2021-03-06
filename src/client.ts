import { EventEmitter } from 'events';
import { Writable, Readable } from 'stream';

import {
  IConfig,
  IClientOptions,
  IStrategiesMap,
  IFile,
  IClientWorkerGroup,
  ITransferProgressListener,
  ITransfer,
  ITaskHandler,
  IOptions,
  IFtpConfig,
  IFtpOptions,
  ISFtpOptions,
  ISFtpConfig,
  ITransferDirection,
} from './interfaces';
import { Strategy } from './strategies/strategy';
import { TasksManager } from './tasks';
import { FtpStrategy } from './strategies/ftp';
import { repeat } from './utils/array';
import { getPathFromStream } from './utils/file';
import { SftpStrategy } from './strategies/sftp';
import { createWriteStream, createReadStream } from 'fs';

type IClientEvents =
  | 'connect'
  | 'disconnect'
  | 'transfer-new'
  | 'transfer-abort'
  | 'transfer-finish'
  | 'transfer-progress';

export declare interface Client {
  on(event: 'connect', listener: () => void): this;
  on(event: 'disconnect', listener: () => void): this;
  on(event: 'transfer-new', listener: (e: ITransfer) => void): this;
  on(event: 'transfer-abort', listener: (...ids: number[]) => void): this;
  on(event: 'transfer-finish', listener: (e: ITransfer) => void): this;
  on(event: 'transfer-progress', listener: ITransferProgressListener): this;

  once(event: 'connect', listener: () => void): this;
  once(event: 'disconnect', listener: () => void): this;
  once(event: 'transfer-new', listener: (e: ITransfer) => void): this;
  once(event: 'transfer-abort', listener: (...ids: number[]) => void): this;
  once(event: 'transfer-finish', listener: (e: ITransfer) => void): this;
  once(event: 'transfer-progress', listener: ITransferProgressListener): this;

  addListener(event: IClientEvents, listener: Function): this;
  removeListener(event: IClientEvents, listener: Function): this;
}

/**
 * High-level API, which handles strategies.
 *
 * It allows to call methods asynchronously.
 */
export class Client extends EventEmitter {
  protected _config?: IConfig;

  protected _connectionOptions?: IOptions;

  protected options: IClientOptions;

  protected workers: Strategy[] = [];

  protected tasks = new TasksManager<Strategy>();

  protected transfers = new Map<number, number>(); // task id => worker index;

  protected strategy: typeof Strategy;

  protected strategies: IStrategiesMap = {
    ftp: FtpStrategy,
    ftps: FtpStrategy,
    sftp: SftpStrategy,
  };

  /**
   * Previously set config.
   */
  public get config() {
    return this._config;
  }

  /**
   * You can set a pool of clients, which will create multiple channels for faster communication.
   */
  constructor(options?: IClientOptions) {
    super();

    this.options = { pool: 1, ...options };

    this.tasks.getWorkerInstance = this.getWorkerInstance;
    this.tasks.workerFilter = this.workerFilter;
  }

  public registerProtocol(protocol: string, strategy: typeof Strategy) {
    this.strategies[protocol] = strategy;
  }

  public unregisterProtocol(protocol: string) {
    delete this.strategies[protocol];
  }

  protected createWorker() {
    const { protocol } = this.config;
    const strategy = this.strategies[protocol];

    if (!strategy) {
      throw new Error(`Strategy for protocol ${protocol} not found.`);
    }

    return new strategy(this.config, this._connectionOptions);
  }

  protected setWorkers() {
    this.workers.forEach(this.clearWorkerEvents);
    this.workers = [];

    const { pool } = this.options;

    for (let i = 0; i < pool; i++) {
      const worker = this.createWorker();

      this.handleWorkerEvents(worker);

      this.workers.push(worker);
    }

    this.setWorkerGroups();
  }

  protected handleWorkerEvents = (instance: Strategy) => {
    instance.on('connect', this.onConnect);
    instance.on('disconnect', this.onDisconnect);
    instance.on('progress', this.onProgress);
  };

  protected clearWorkerEvents = (instance: Strategy) => {
    instance.removeListener('connect', this.onConnect);
    instance.removeListener('disconnect', this.onDisconnect);
    instance.removeListener('progress', this.onProgress);
  };

  protected setWorkerGroups() {
    const { pool, transferPool } = this.options;
    const groups: IClientWorkerGroup[] = [];

    if (!transferPool || pool === 1) {
      groups.push(...repeat<IClientWorkerGroup>('all', pool));
    } else {
      groups.push('misc', ...repeat<IClientWorkerGroup>('transfer', pool - 1));
    }

    this.tasks.setWorkers(...groups);
  }

  protected getWorkerInstance = (index: number) => {
    return this.workers[index];
  };

  protected workerFilter = (worker, group: IClientWorkerGroup) => {
    return (
      worker.group === 'all' ||
      (!group && worker.group === 'misc') ||
      worker.group === group
    );
  };

  /**
   * Connects to a server. If you're already connected, it disconnects.
   *
   * It saves `config` and `options`, so you can call it without providing these arguments later.
   */
  public async connect(config?: IFtpConfig, options?: IFtpOptions);
  public async connect(config?: ISFtpConfig, options?: ISFtpOptions);
  public async connect(config?: IConfig, options?: IOptions) {
    if (!this._config && !config) {
      throw new Error('Config must be provided!');
    }

    await this.disconnect();

    if (config) this._config = config;
    if (options) this._connectionOptions = options;

    this.setWorkers();

    await Promise.all(this.workers.map((r) => r.connect()));
  }

  public async disconnect() {
    await Promise.all(this.workers.map((r) => r.disconnect()));
  }

  /**
   * Aborts every proccesed and waiting task.
   */
  public async abort() {
    this.emit('transfer-abort', ...this.transfers.keys());

    this.tasks.deleteAllTasks();

    await Promise.all(this.workers.map((r) => r.abort()));
  }

  /**
   * Aborts specified file transfers.
   */
  public async abortTransfer(...transferIds: number[]) {
    const workerIndexes: number[] = [];
    const instances: Strategy[] = [];

    transferIds.forEach((id) => {
      const workerIndex = this.transfers.get(id);

      if (workerIndex != null) {
        instances.push(this.workers[workerIndex]);
      }

      workerIndexes.push(workerIndex);

      this.emit('transfer-abort', id);
    });

    this.tasks.deleteTasks(...transferIds);
    this.tasks.pauseWorkers(...workerIndexes);

    await Promise.all(instances.map((r) => r.abort()));

    this.tasks.resumeWorkers(...workerIndexes);
  }

  /**
   * Downloads a remote file.
   *
   * @param dest can be either `Writable` stream or path of a local file.
   * @param startAt can be set to resume download.
   */
  public download(
    dest: Writable | string,
    remotePath: string,
    startAt?: number,
  ) {
    let stream: Writable;
    let localPath: string;

    if (typeof dest === 'string') {
      stream = createWriteStream(dest, {
        flags: startAt ? 'a' : 'w',
        start: startAt,
      });

      localPath = dest;
    } else {
      stream = dest;
      localPath = getPathFromStream(dest);
    }

    return this.handleTransfer(
      async ({ instance, taskId }) => {
        const totalBytes = await instance.size(remotePath);

        await instance.download(stream, {
          id: taskId,
          startAt,
          localPath,
          remotePath,
          totalBytes,
        });
      },
      { remotePath, localPath },
    );
  }

  /**
   * Uploads a local file.
   *
   * @param source can be either `Readable` stream or path of a remote file.
   */
  public upload(source: Readable | string, remotePath: string) {
    let stream: Readable;
    let localPath: string;

    if (typeof source === 'string') {
      stream = createReadStream(source);
      localPath = source;
    } else {
      stream = source;
      localPath = getPathFromStream(source);
    }

    return this.handleTransfer(
      async ({ instance, taskId }) => {
        const totalBytes = await instance.size(remotePath);

        await instance.upload(stream, {
          id: taskId,
          localPath,
          remotePath,
          totalBytes,
        });
      },
      { remotePath, localPath },
    );
  }

  /**
   * Lists files in a folder.
   */
  public list(path?: string) {
    return this.tasks.handle<IFile[]>(({ instance }) => instance.list(path));
  }

  /**
   * Gets size of a file.
   */
  public size(path: string) {
    return this.tasks.handle<number>(({ instance }) => instance.size(path));
  }

  /**
   * Checks if a file or a folder exists.
   */
  public exists(path: string) {
    return this.tasks.handle<boolean>(({ instance }) => instance.exists(path));
  }

  /**
   * Moves a file or a folder.
   * Can be used to rename.
   */
  public move(source: string, dest: string) {
    return this.tasks.handle(({ instance }) => instance.move(source, dest));
  }

  public removeFile(path: string) {
    return this.tasks.handle(({ instance }) => instance.removeFile(path));
  }

  public removeEmptyFolder(path: string) {
    return this.tasks.handle(({ instance }) =>
      instance.removeEmptyFolder(path),
    );
  }

  /**
   * Removes a folder and all of its content.
   */
  public removeFolder(path: string) {
    return this.tasks.handle(({ instance }) => instance.removeFolder(path));
  }

  public createFolder(path: string) {
    return this.tasks.handle(({ instance }) => instance.createFolder(path));
  }

  /**
   * Creates an empty file. Similar to `touch` in Unix.
   */
  public createEmptyFile(path: string) {
    return this.tasks.handle(({ instance }) => instance.createEmptyFile(path));
  }

  /**
   * Gets current working directory.
   */
  public pwd() {
    return this.tasks.handle<string>(({ instance }) => instance.pwd());
  }

  /**
   * Sends a raw command. Support not guaranteed.
   */
  public send(command: string) {
    return this.tasks.handle<string>(({ instance }) => instance.send(command));
  }

  protected onConnect = () => {
    this.emit('connect');
  };

  protected onDisconnect = () => {
    this.emit('disconnect');
  };

  protected onProgress = (data, progress) => {
    this.emit('transfer-progress', data, progress);
  };

  protected async handleTransfer(
    fn: ITaskHandler<Strategy>,
    direction: ITransferDirection,
  ) {
    const taskId = this.tasks.createTaskId();
    const transfer: ITransfer = { id: taskId, ...direction };

    this.transfers.set(taskId, null);
    this.emit('transfer-new', transfer);

    try {
      await this.tasks.handle(
        async (e) => {
          this.transfers.set(taskId, e.workerIndex);

          await fn(e);
        },
        'transfer-transfer',
        taskId,
      );
    } catch (err) {
      throw err;
    } finally {
      this.transfers.delete(taskId);
      this.emit('transfer-finish', transfer);
    }
  }
}
