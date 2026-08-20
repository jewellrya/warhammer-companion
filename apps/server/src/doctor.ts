/**
 * Environment check. Run `pnpm doctor` when something is not working.
 */

import { AppContext, defaultConfig } from "./context.js";

const ok = (b: boolean): string => (b ? "  ok  " : " FAIL ");

async function main(): Promise<void> {
  const cfg = defaultConfig();
  console.log("Warhammer Companion — environment check\n");

  const ctx = new AppContext(cfg);
  const status = await ctx.refresh();

  console.log(`[${ok(true)}] SQLite      ${status.dbPath}`);

  console.log(
    `[${ok(status.oracle.available)}] Oracle      ${
      status.oracle.available
        ? `${status.oracle.tools.length} tools: ${status.oracle.tools.slice(0, 5).join(", ")}…`
        : (status.oracle.error ?? "not reachable")
    }`,
  );
  if (!status.oracle.available) {
    console.log(
      "          → Oracle is fetched via npx on first use. Check your network,\n" +
        "            or set ORACLE_COMMAND to a local warhammer-oracle build.",
    );
  }

  console.log(
    `[${ok(status.llm.available)}] Local LLM   ${
      status.llm.available
        ? `${status.llm.provider} / ${status.llm.model}`
        : "not available — falling back to the rule interpreter"
    }`,
  );
  if (!status.llm.available) {
    console.log(
      "          → brew install ollama && ollama serve\n" +
        `          → ollama pull ${status.llm.model}`,
    );
    if (status.llm.models.length > 0) {
      console.log(`          → models present: ${status.llm.models.join(", ")}`);
    }
  }

  console.log(`\nInterpreter in use: ${status.interpreter}`);

  if (status.oracle.available) {
    const unit = await ctx.oracle.getUnit("Deathshroud Terminators", {
      faction: "Death Guard",
    });
    console.log(
      `[${ok(unit !== null)}] Sample query  Deathshroud Terminators → ${
        unit ? `${unit.data.points}pts, T${unit.data.profiles[0]?.toughness}, ${unit.data.weapons.length} weapons` : "not found"
      }`,
    );
  }

  await ctx.close();
  await exit(status.oracle.available ? 0 : 1);
}

/**
 * The MCP client holds a child process open, so this has to exit explicitly —
 * but a bare process.exit() drops buffered stdout when the output is piped
 * (which is exactly what `pnpm doctor` does), making the report vanish.
 * Flush first, then leave.
 */
async function exit(code: number): Promise<never> {
  await new Promise<void>((resolve) => {
    if (process.stdout.write("")) resolve();
    else process.stdout.once("drain", () => resolve());
  });
  process.exit(code);
}

main().catch(async (err) => {
  console.error(err);
  await exit(1);
});
