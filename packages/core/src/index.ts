/** Public surface of the domain core. Apps import from here only. */

// Domain
export * from "./domain/types.js";
export * from "./domain/events.js";
export * from "./domain/intent.js";
export {
  applyEvent,
  replay,
  advancePhase,
  remainingWounds,
} from "./domain/reducer.js";
export {
  resolveUnit,
  resolveObjective,
  resolveSide,
  type ResolveResult,
  type ResolveOptions,
} from "./domain/resolve.js";

// Oracle
export * from "./oracle/provider.js";
export { OracleProvider, woundTarget } from "./oracle/oracle-provider.js";
export { McpStdioClient, type McpClientOptions, type McpToolInfo } from "./oracle/mcp-client.js";
export * as oracleMarkdown from "./oracle/markdown.js";

// AI
export * from "./ai/provider.js";
export { OllamaProvider, type OllamaOptions } from "./ai/ollama.js";
export {
  MockInterpreter,
  LLMInterpreter,
  createInterpreter,
  type Interpreter,
  type InterpreterContext,
} from "./ai/interpreter.js";
export { ruleInterpret, parseNumber } from "./ai/rule-interpreter.js";

// Persistence
export { openDatabase, type Db } from "./db/schema.js";
export {
  Repository,
  type BattleSummary,
  type ChatMessageRow,
} from "./db/repository.js";

// Application services
export {
  BattleService,
  describeEvent,
  type TurnResult,
  type StartBattleInput,
} from "./app/battle-service.js";
export {
  answerQuestion,
  type RulesAnswer,
  type AnswerContext,
} from "./app/rules-service.js";
export {
  importArmyFromText,
  parseListStructurally,
  type ImportResult,
  type ParsedListLine,
} from "./app/army-service.js";
export {
  ChronicleService,
  buildChronicleEntry,
} from "./app/chronicle-service.js";
export { nameVariants } from "./app/name-variants.js";
export {
  CollectionService,
  ruleParseCollection,
  type CollectionUpdate,
} from "./app/collection-service.js";
