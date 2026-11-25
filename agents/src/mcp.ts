// MCP server over stdio: the same tools as the SDK, for the owner's own AI agent.
//
// It runs LOCALLY with the owner's wallet (AGENT_PRIVATE_KEY from the environment, never exposed through a tool
// and never logged). The process must stay running (or be restarted) during the reveal window: `submit_path`
// schedules the reveal inside this process, and on start the server resumes reveals for committed entries.
// stdout carries the MCP protocol; every log line goes to stderr.
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AgentError, defaultAgentFromEnv, pathFromNumbers, shortMessage, type Agent } from "./sdk";

const roundId = z
  .union([z.string().regex(/^[1-9][0-9]*$/, "round id: a positive integer"), z.number().int().positive()])
  .describe("Round id (positive integer)");

const limit = z.number().int().min(1).max(50).optional().describe("How many rounds to return, newest first (default 20, max 50)");

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (value: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });

/** Error text for the model: our own messages and viem short messages only, URLs masked (RPC URLs can carry API keys), never a key or a stack. */
const fail = (e: unknown): ToolResult => ({
  content: [{ type: "text", text: e instanceof AgentError ? `${e.code}: ${e.message}` : `error: ${shortMessage(e)}` }],
  isError: true,
});

async function guard(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (e) {
    return fail(e);
  }
}

/** Builds the MCP server around any agent (the real one from the environment, or a test double). */
export function createMcpServer(getAgent: () => Promise<Agent>): McpServer {
  const server = new McpServer({ name: "consensus-path-agent", version: "0.1.0" });

  server.registerTool(
    "list_rounds",
    { description: "List the latest rounds: ticker, phase, schedule (unix seconds), T, entry stake and reveal counts.", inputSchema: { limit } },
    ({ limit: n }) => guard(async () => (await getAgent()).listRounds(n)),
  );

  server.registerTool(
    "get_round",
    {
      description:
        "One round: ticker, P0, T (tolerance in basis points), phase schedule, bucket width, reveal counts and, when a candle provider is configured, recent candles. All path values are int32 basis points relative to P0.",
      inputSchema: { id: roundId },
    },
    ({ id }) => guard(async () => (await getAgent()).getRound(BigInt(id))),
  );

  server.registerTool(
    "get_consensus",
    {
      description: "Human and agent consensus paths once frozen after the reveal window; final scores and the real candles after settlement.",
      inputSchema: { id: roundId },
    },
    ({ id }) => guard(async () => (await getAgent()).getConsensus(BigInt(id))),
  );

  server.registerTool(
    "submit_path",
    {
      description:
        "Commit a 3-candle path. Takes 9 integers (basis points relative to P0) ordered close1, high1, low1, close2, high2, low2, close3, high3, low3. Candle 1 opens at 0, each later candle opens at the previous close; every candle needs low <= min(open, close) and high >= max(open, close). The salt is generated and saved to disk before the commit is sent; the reveal is sent automatically in the reveal window, so this process must keep running (or be restarted) until then, otherwise the entry is forfeited.",
      inputSchema: {
        id: roundId,
        path: z.array(z.number().int()).length(9).describe("[close1, high1, low1, close2, high2, low2, close3, high3, low3] in bp"),
      },
    },
    ({ id, path }) =>
      guard(async () => {
        const agent = await getAgent();
        const rid = BigInt(id);
        await agent.submitPath(rid, pathFromNumbers(path));
        return { submitted: true, round: rid.toString(), entry: agent.mySubmission(rid), reveal: agent.revealOutcome(rid) };
      }),
  );

  server.registerTool(
    "get_my_results",
    {
      description: "This agent's entries per round: committed hash, reveal status, score against the real candles, baseline and reward points.",
      inputSchema: { limit },
    },
    ({ limit: n }) => guard(async () => (await getAgent()).getMyResults(n)),
  );

  return server;
}

export async function main(): Promise<void> {
  const agent = await defaultAgentFromEnv();
  try {
    const resumed = await agent.resumePending();
    if (resumed.length > 0) console.error(`[agent] resumed reveals for rounds ${resumed.join(", ")}`);
  } catch (e) {
    // The server stays up (reads still work); the owner can restart once the RPC is back.
    console.error(`[agent] could not resume pending reveals: ${shortMessage(e)}`);
  }
  const server = createMcpServer(() => Promise.resolve(agent));
  await server.connect(new StdioServerTransport());
  console.error(`[agent] MCP server ready for ${agent.address}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error(`[agent] fatal: ${e instanceof AgentError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
