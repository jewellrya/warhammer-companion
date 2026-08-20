/**
 * The seam between this app and whoever supplies Warhammer knowledge.
 *
 * Everything above this file talks in these types and never mentions MCP,
 * Oracle, or markdown. That is what lets Oracle be swapped, supplemented with a
 * document library, or cached, without touching battle logic.
 */

import type { Edition } from "../domain/types.js";

export interface StatProfile {
  name: string;
  movement: string;
  toughness: string;
  save: string;
  wounds: string;
  leadership: string;
  objectiveControl: string;
}

export interface WeaponProfile {
  name: string;
  range: string;
  attacks: string;
  /** BS for ranged, WS for melee. */
  skill: string;
  strength: string;
  armourPenetration: string;
  damage: string;
  keywords: string[];
  kind: "ranged" | "melee";
}

export interface AbilityInfo {
  name: string;
  description: string;
}

export interface UnitData {
  name: string;
  faction: string;
  points: number | null;
  unitSize: { min: number; max: number };
  profiles: StatProfile[];
  weapons: WeaponProfile[];
  abilities: AbilityInfo[];
  keywords: string[];
  edition: Edition;
  /** The unparsed Oracle response, kept so answers can cite exact text. */
  raw: string;
}

export interface UnitSummary {
  name: string;
  faction: string;
  points: number | null;
  unitSize?: { min: number; max: number };
  keywords: string[];
}

export interface StratagemData {
  name: string;
  faction?: string;
  detachment?: string;
  cpCost: number | null;
  phase?: string;
  when?: string;
  target?: string;
  effect?: string;
  raw: string;
}

export interface KeywordData {
  name: string;
  description: string;
  plainEnglish?: string;
  examples?: string[];
  raw: string;
}

export interface PhaseData {
  name: string;
  steps: string[];
  tips: string[];
  raw: string;
}

export interface GameFlowData {
  phases: string[];
  current?: string;
  next?: string;
  raw: string;
}

export interface WoundCalcInput {
  attacks: number;
  hitSkill: number;
  strength: number;
  toughness: number;
  armourSave: number;
  damage: string;
  armourPenetration?: number;
  invulnerableSave?: number;
  feelNoPain?: number;
  rerollHits?: "ones" | "all";
  rerollWounds?: "ones" | "all";
  weaponKeywords?: string[];
  woundsPerModel?: number;
  edition?: Edition;
}

export interface WoundCalcResult {
  expectedHits: number | null;
  expectedWounds: number | null;
  expectedUnsaved: number | null;
  expectedDamage: number | null;
  /** Target number to wound, derived from S vs T locally. */
  woundOn?: number;
  interactions: string[];
  raw: string;
}

export interface DetachmentData {
  name: string;
  faction?: string;
  ability?: string;
  enhancements: string[];
  stratagems: string[];
  raw: string;
}

export interface EnhancementData {
  name: string;
  faction?: string;
  detachment?: string;
  points: number | null;
  effect?: string;
  raw: string;
}

/** Every lookup carries provenance so the UI can show where an answer came from. */
export interface SourceCitation {
  provider: string;
  tool: string;
  edition: Edition;
  query: Record<string, unknown>;
}

export interface Sourced<T> {
  data: T;
  source: SourceCitation;
}

export interface LookupOptions {
  edition?: Edition;
  faction?: string;
}

/**
 * The contract from the brief. Implementations must not throw for "not found" —
 * they return null so callers can fall back or ask the user.
 */
export interface WarhammerDataProvider {
  readonly name: string;
  isAvailable(): Promise<boolean>;

  getUnit(name: string, opts?: LookupOptions): Promise<Sourced<UnitData> | null>;
  searchUnits(
    query: string,
    opts?: LookupOptions & { ability?: string; maxPoints?: number },
  ): Promise<Sourced<UnitSummary[]>>;
  getStratagem(
    name: string,
    opts?: LookupOptions & { phase?: string; detachment?: string },
  ): Promise<Sourced<StratagemData> | null>;
  searchStratagems(
    query: string,
    opts?: LookupOptions & { phase?: string; detachment?: string },
  ): Promise<Sourced<StratagemData[]>>;
  getKeyword(name: string, opts?: LookupOptions): Promise<Sourced<KeywordData> | null>;
  getPhase(name: string, opts?: LookupOptions): Promise<Sourced<PhaseData> | null>;
  getGameFlow(
    opts?: LookupOptions & { currentPhase?: string },
  ): Promise<Sourced<GameFlowData>>;
  calculateWounds(input: WoundCalcInput): Promise<Sourced<WoundCalcResult>>;
  getDetachment(
    name: string,
    opts?: LookupOptions,
  ): Promise<Sourced<DetachmentData> | null>;
  getEnhancement(
    name: string,
    opts?: LookupOptions & { detachment?: string },
  ): Promise<Sourced<EnhancementData> | null>;

  /** Escape hatch for tools without a first-class method yet. */
  rawTool?(tool: string, args: Record<string, unknown>): Promise<string>;

  close?(): Promise<void>;
}
