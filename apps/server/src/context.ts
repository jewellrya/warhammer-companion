/**
 * Wires the app together and decides which backends are actually live.
 *
 * Everything degrades rather than failing: no Ollama means the rule
 * interpreter, no Oracle means lookups return errors but battle state still
 * works. The UI reads `status()` to tell the user what is running.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import {
  BattleService,
  ChronicleService,
  CollectionService,
  MockInterpreter,
  LLMInterpreter,
  OllamaProvider,
  OracleProvider,
  Repository,
  openDatabase,
  type Edition,
  type Interpreter,
} from "@wh/core";

export interface AppConfig {
  dbPath: string;
  edition: Edition;
  oracleCommand?: string;
  ollamaModel?: string;
  ollamaHost?: string;
}

export function defaultConfig(): AppConfig {
  return {
    dbPath:
      process.env.WH_DB_PATH ??
      join(homedir(), ".warhammer-companion", "companion.db"),
    edition: (process.env.WH_EDITION as Edition) ?? "40k_11e",
    oracleCommand: process.env.ORACLE_COMMAND,
    ollamaModel: process.env.OLLAMA_MODEL,
    ollamaHost: process.env.OLLAMA_HOST,
  };
}

export interface BackendStatus {
  oracle: { available: boolean; tools: string[]; error?: string };
  llm: { available: boolean; provider: string; model: string; models: string[] };
  interpreter: string;
  edition: Edition;
  dbPath: string;
}

export class AppContext {
  readonly repo: Repository;
  readonly oracle: OracleProvider;
  readonly ollama: OllamaProvider;
  readonly config: AppConfig;

  private interpreter: Interpreter = new MockInterpreter();
  private llmLive = false;
  private battleSvc!: BattleService;
  private collectionSvc!: CollectionService;
  private chronicleSvc!: ChronicleService;

  constructor(config: AppConfig = defaultConfig()) {
    this.config = config;
    this.repo = new Repository(openDatabase(config.dbPath));
    this.oracle = new OracleProvider({
      defaultEdition: config.edition,
      ...(config.oracleCommand
        ? {
            command: config.oracleCommand.split(" ")[0]!,
            args: config.oracleCommand.split(" ").slice(1),
          }
        : {}),
    });
    this.ollama = new OllamaProvider({
      model: config.ollamaModel,
      baseUrl: config.ollamaHost,
    });
    this.rebuildServices();
  }

  /** Probe backends and pick the best interpreter. Safe to call repeatedly. */
  async refresh(): Promise<BackendStatus> {
    this.llmLive = await this.ollama.isAvailable();
    this.interpreter = this.llmLive
      ? new LLMInterpreter(this.ollama)
      : new MockInterpreter();
    this.rebuildServices();
    return this.status();
  }

  private rebuildServices(): void {
    const llm = this.llmLive ? this.ollama : null;
    this.battleSvc = new BattleService(
      this.repo,
      this.oracle,
      this.interpreter,
      llm,
    );
    this.collectionSvc = new CollectionService(this.repo, this.oracle, llm);
    this.chronicleSvc = new ChronicleService(this.repo, llm);
  }

  get battles(): BattleService {
    return this.battleSvc;
  }
  get collection(): CollectionService {
    return this.collectionSvc;
  }
  get chronicle(): ChronicleService {
    return this.chronicleSvc;
  }
  get llm(): OllamaProvider | null {
    return this.llmLive ? this.ollama : null;
  }

  async status(): Promise<BackendStatus> {
    let tools: string[] = [];
    let oracleOk = false;
    let oracleErr: string | undefined;
    try {
      tools = await this.oracle.listTools();
      oracleOk = tools.length > 0;
    } catch (err) {
      oracleErr = err instanceof Error ? err.message : String(err);
    }

    return {
      oracle: { available: oracleOk, tools, error: oracleErr },
      llm: {
        available: this.llmLive,
        provider: this.ollama.name,
        model: this.ollama.model,
        models: await this.ollama.listModels(),
      },
      interpreter: this.interpreter.name,
      edition: this.config.edition,
      dbPath: this.config.dbPath,
    };
  }

  async close(): Promise<void> {
    await this.oracle.close();
  }
}
