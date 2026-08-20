/**
 * Warhammer Oracle as a WarhammerDataProvider.
 *
 * All MCP and markdown knowledge stops here. Two things worth knowing about
 * the server: its npm bin is `warhammer-oracle-11e` (not the package name), and
 * every tool answers in markdown, so each method is "call tool, parse, cite".
 *
 * Lookups are memoised per (tool, args) because Oracle's data is static between
 * releases and a battle asks for the same datasheet many times.
 */

import type { Edition } from "../domain/types.js";
import { McpStdioClient, type McpClientOptions } from "./mcp-client.js";
import * as md from "./markdown.js";
import type {
  DetachmentData,
  EnhancementData,
  GameFlowData,
  KeywordData,
  LookupOptions,
  PhaseData,
  SourceCitation,
  Sourced,
  StratagemData,
  UnitData,
  UnitSummary,
  WarhammerDataProvider,
  WoundCalcInput,
  WoundCalcResult,
} from "./provider.js";

/**
 * Oracle's tools do not share one `game_mode` vocabulary, and passing the wrong
 * one is a hard schema rejection rather than a fallback. Three groups exist:
 *
 *  - datasheet tools take the full set including the edition split
 *  - core-rules tools are edition-agnostic and reject `40k_10e`/`40k_11e`
 *  - detachment/enhancement tools take editions but no Kill Team
 *  - the rest take no `game_mode` at all
 */
type ModeGroup = "full" | "core" | "edition" | "none";

const TOOL_MODE_GROUP: Record<string, ModeGroup> = {
  lookup_unit: "full",
  search_units: "full",
  compare_units: "full",
  lookup_keyword: "core",
  lookup_phase: "core",
  game_flow: "core",
  wound_calculator: "core",
  lookup_detachment: "edition",
  lookup_enhancement: "edition",
  lookup_stratagem: "none",
  search_stratagems: "none",
  lookup_ploy: "none",
  determine_primary_mission: "none",
  lookup_crusade: "none",
};

/** The `game_mode` value a given tool will accept for an edition, if any. */
function gameModeFor(tool: string, edition: Edition): string | undefined {
  switch (TOOL_MODE_GROUP[tool] ?? "none") {
    case "full":
      return edition;
    case "core":
      // Both 40K editions collapse to "40k" here; core rules are shared.
      return edition === "kill_team"
        ? "kill_team"
        : edition === "combat_patrol"
          ? "combat_patrol"
          : "40k";
    case "edition":
      // No Kill Team detachments; fall back to the current 40K edition.
      return edition === "40k_10e" ? "40k_10e" : "40k_11e";
    case "none":
      return undefined;
  }
}

export interface OracleProviderOptions extends Partial<McpClientOptions> {
  /** Edition used when a call does not name one. */
  defaultEdition?: Edition;
  cacheSize?: number;
}

/** Resolve how to launch Oracle: explicit override, else the npm-installed bin. */
function defaultLaunch(): { command: string; args: string[] } {
  const override = process.env.ORACLE_COMMAND;
  if (override) {
    const parts = override.split(" ").filter(Boolean);
    return { command: parts[0] ?? "npx", args: parts.slice(1) };
  }
  // `-p` is required because the package's bin name differs from its name.
  return {
    command: "npx",
    args: ["-y", "-p", "warhammer-oracle", "warhammer-oracle-11e"],
  };
}

export class OracleProvider implements WarhammerDataProvider {
  readonly name = "warhammer-oracle";
  private readonly mcp: McpStdioClient;
  private readonly defaultEdition: Edition;
  private readonly cache = new Map<string, string>();
  private readonly cacheSize: number;

  constructor(opts: OracleProviderOptions = {}) {
    const launch = defaultLaunch();
    this.mcp = new McpStdioClient({
      command: opts.command ?? launch.command,
      args: opts.args ?? launch.args,
      cwd: opts.cwd,
      env: opts.env,
      clientName: "warhammer-companion",
      timeoutMs: opts.timeoutMs ?? 30_000,
    });
    this.defaultEdition = opts.defaultEdition ?? "40k_11e";
    this.cacheSize = opts.cacheSize ?? 500;
  }

  private edition(opts?: LookupOptions): Edition {
    return opts?.edition ?? this.defaultEdition;
  }

  private cite(
    tool: string,
    edition: Edition,
    query: Record<string, unknown>,
  ): SourceCitation {
    return { provider: this.name, tool, edition, query };
  }

  /** Cached tool call. Undefined args are dropped so keys stay stable. */
  private async call(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const clean = Object.fromEntries(
      Object.entries(args).filter(([, v]) => v !== undefined && v !== null),
    );
    const key = `${tool}:${JSON.stringify(clean)}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;

    const text = await this.mcp.callText(tool, clean);

    if (this.cache.size >= this.cacheSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, text);
    return text;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const tools = await this.mcp.listTools();
      return tools.some((t) => t.name === "lookup_unit");
    } catch {
      return false;
    }
  }

  async listTools(): Promise<string[]> {
    const tools = await this.mcp.listTools();
    return tools.map((t) => t.name);
  }

  async getUnit(
    name: string,
    opts?: LookupOptions,
  ): Promise<Sourced<UnitData> | null> {
    const edition = this.edition(opts);
    const query = {
      unit_name: name,
      faction: opts?.faction,
      game_mode: gameModeFor("lookup_unit", edition),
    };
    const text = await this.call("lookup_unit", query);
    const data = md.parseUnit(text, edition);
    if (!data) return null;
    return { data, source: this.cite("lookup_unit", edition, query) };
  }

  async searchUnits(
    q: string,
    opts?: LookupOptions & { ability?: string; maxPoints?: number },
  ): Promise<Sourced<UnitSummary[]>> {
    const edition = this.edition(opts);
    const query = {
      query: q,
      faction: opts?.faction,
      ability: opts?.ability,
      max_points: opts?.maxPoints,
      game_mode: gameModeFor("search_units", edition),
    };
    const text = await this.call("search_units", query);
    return {
      data: md.parseUnitSummaries(text),
      source: this.cite("search_units", edition, query),
    };
  }

  async getStratagem(
    name: string,
    opts?: LookupOptions & { phase?: string; detachment?: string },
  ): Promise<Sourced<StratagemData> | null> {
    const edition = this.edition(opts);
    const query = {
      name,
      faction: opts?.faction,
      phase: opts?.phase,
      detachment: opts?.detachment,
    };
    const text = await this.call("lookup_stratagem", query);
    const data = md.parseStratagem(text);
    if (!data) return null;
    return { data, source: this.cite("lookup_stratagem", edition, query) };
  }

  async searchStratagems(
    q: string,
    opts?: LookupOptions & { phase?: string; detachment?: string },
  ): Promise<Sourced<StratagemData[]>> {
    const edition = this.edition(opts);
    const query = {
      query: q,
      faction: opts?.faction,
      phase: opts?.phase,
      detachment: opts?.detachment,
    };
    const text = await this.call("search_stratagems", query);
    return {
      data: md.parseStratagemList(text),
      source: this.cite("search_stratagems", edition, query),
    };
  }

  async getKeyword(
    name: string,
    opts?: LookupOptions,
  ): Promise<Sourced<KeywordData> | null> {
    const edition = this.edition(opts);
    const query = { keyword: name, game_mode: gameModeFor("lookup_keyword", edition) };
    const text = await this.call("lookup_keyword", query);
    const data = md.parseKeyword(text);
    if (!data) return null;
    return { data, source: this.cite("lookup_keyword", edition, query) };
  }

  async getPhase(
    name: string,
    opts?: LookupOptions,
  ): Promise<Sourced<PhaseData> | null> {
    const edition = this.edition(opts);
    const query = { phase_name: name, game_mode: gameModeFor("lookup_phase", edition) };
    const text = await this.call("lookup_phase", query);
    const data = md.parsePhase(text);
    if (!data) return null;
    return { data, source: this.cite("lookup_phase", edition, query) };
  }

  async getGameFlow(
    opts?: LookupOptions & { currentPhase?: string },
  ): Promise<Sourced<GameFlowData>> {
    const edition = this.edition(opts);
    const query = {
      current_phase: opts?.currentPhase,
      game_mode: gameModeFor("game_flow", edition),
    };
    const text = await this.call("game_flow", query);
    return {
      data: md.parseGameFlow(text),
      source: this.cite("game_flow", edition, query),
    };
  }

  async calculateWounds(
    input: WoundCalcInput,
  ): Promise<Sourced<WoundCalcResult>> {
    const edition = input.edition ?? this.defaultEdition;
    const query = {
      attacks: input.attacks,
      hit_skill: input.hitSkill,
      strength: input.strength,
      toughness: input.toughness,
      armour_save: input.armourSave,
      damage: input.damage,
      armour_penetration: input.armourPenetration,
      invulnerable_save: input.invulnerableSave,
      feel_no_pain: input.feelNoPain,
      reroll_hits: input.rerollHits,
      reroll_wounds: input.rerollWounds,
      weapon_keywords: input.weaponKeywords,
      wounds_per_model: input.woundsPerModel,
      game_mode: gameModeFor("wound_calculator", edition),
    };
    const text = await this.call("wound_calculator", query);
    const data = md.parseWoundCalc(text);
    // Oracle prints the numbers but not the wound target; it is pure S-vs-T.
    data.woundOn = woundTarget(input.strength, input.toughness);
    return { data, source: this.cite("wound_calculator", edition, query) };
  }

  async getDetachment(
    name: string,
    opts?: LookupOptions,
  ): Promise<Sourced<DetachmentData> | null> {
    const edition = this.edition(opts);
    const query = {
      name,
      faction: opts?.faction,
      game_mode: gameModeFor("lookup_detachment", edition),
    };
    const text = await this.call("lookup_detachment", query);
    const data = md.parseDetachment(text);
    if (!data) return null;
    return { data, source: this.cite("lookup_detachment", edition, query) };
  }

  async getEnhancement(
    name: string,
    opts?: LookupOptions & { detachment?: string },
  ): Promise<Sourced<EnhancementData> | null> {
    const edition = this.edition(opts);
    const query = {
      name,
      faction: opts?.faction,
      detachment: opts?.detachment,
      game_mode: gameModeFor("lookup_enhancement", edition),
    };
    const text = await this.call("lookup_enhancement", query);
    const data = md.parseEnhancement(text);
    if (!data) return null;
    return { data, source: this.cite("lookup_enhancement", edition, query) };
  }

  /** Raw passthrough for Oracle tools without a typed method yet. */
  async rawTool(tool: string, args: Record<string, unknown>): Promise<string> {
    return this.call(tool, args);
  }

  async close(): Promise<void> {
    await this.mcp.close();
  }
}

/**
 * Standard 40K wound chart. Lives here rather than in Oracle calls because the
 * battle assistant needs it synchronously to narrate "wound on 3+".
 */
export function woundTarget(strength: number, toughness: number): number {
  if (strength >= toughness * 2) return 2;
  if (strength > toughness) return 3;
  if (strength === toughness) return 4;
  if (strength * 2 <= toughness) return 6;
  return 5;
}
